/**
 * Nodino v2 — embeddable 2D force-directed graph viewer.
 * See nodino.dox.md for the specification this implementation follows.
 *
 * If any chrome is used (config.debug / showDebugToggle / showSimControls /
 * showViewModeToggle / showGeometryToggle / showSearch / showStats /
 * showRunTime / showProgressBar), the host page must also link nodino.css —
 * it holds all the menu/chrome styling (debug panel and its toggle,
 * simulation controls, view mode toggle, geometry toggle, search bar and its
 * autocomplete list, detail panel, readouts, progress bar). The canvas itself
 * needs nothing from it: the graph's own visual style stays programmatic
 * (config.style), independent of this file.
 *
 * Those nine flags plus showPulse are host-level embedding choices,
 * settable at create() and changeable at any time through updateConfig() —
 * none of them is exposed in the debug panel, which is for tuning the
 * layout, not for deciding which chrome an embedding shows. Two of them gate
 * more than their own component. showDebugToggle gates the config panel as
 * well as its ⚙ button (effective visibility is `debug && showDebugToggle`),
 * so hiding it can never strand an open panel with no way to close it; and
 * showViewModeToggle gates the automatic view-mode switching along with the
 * control, so a host that hides the toggle owns config.viewMode outright.
 *
 * @typedef {{ m?: object }} NodinoNodeEntry - `m` = metadata, opaque to Nodino. Terse because it repeats once per node in the input payload.
 * @typedef {Object.<string, NodinoNodeEntry>} NodinoNodesInput
 * @typedef {[string, string, number]} NodinoEdgeInput - [sourceUid, targetUid, weight in [-1, 1]]
 * @typedef {{ x: number, y: number }} NodinoPosition - in [-1, 1], relative to the unit boundary circle. Covering *every* node makes the payload a finished layout rather than a seed, and load() then opens it settled ([D Data.3]).
 * @typedef {{ x: number, y: number, z: number }} NodinoGlobePosition - a vector on the unit sphere, renormalized on the way in ([D Globe.9]). The spherical layout's own bootstrap, independent of `positions`: either, both or neither may be present, each is partial-capable on its own terms, and only planar coverage decides the lifecycle state ([D Data.3]).
 * @typedef {{ nodes?: NodinoNodesInput, edges: NodinoEdgeInput[], positions?: Object.<string, NodinoPosition>, globePositions?: Object.<string, NodinoGlobePosition>, maxFrames?: number }} NodinoLoadData - `maxFrames` = best step count any previous run of this graph reached, as the host has it stored; seeds the record onSettle compares against ([F Data.4]), and — when `positions` cover every node — the restored layout's own step count too ([D API.7]).
 * @typedef {'empty'|'loaded'|'running'|'running_paused'|'settled'|'forced'|'forced_paused'|'forced_settled'|'destroyed'} NodinoState - lifecycle state, see [F State.1]
 */
(function (global) {
  'use strict';

  var DEFAULT_CONFIG = {
    debug: false,
    // Traces everything that moves the instance to the console: control
    // presses, public method calls, lifecycle transitions, and the host
    // callbacks fired as a result. Off by default — an embedded library has
    // no business writing to a host's console uninvited — and switchable at
    // any time through updateConfig(), since the run you want to inspect is
    // usually the one already in progress. See createLogger().
    logEvents: false,
    // Small always-on button (top-right corner) that flips `debug` live, so the
    // panel doesn't require host code to open/close. `debug` itself still
    // controls the panel's *initial* state (false by default; a host like
    // demo.html can start with it open by passing debug: true). Gates the
    // panel as well, not just the button: see applyChrome().
    showDebugToggle: true,
    // Two independent pairs of thresholds, one per relation sign, kept
    // deliberately separate: "compute" gates whether an edge contributes to
    // the physics at all, "draw" gates only whether it is painted. A weak
    // edge can still pull/push the layout while staying invisible, or be
    // visible while contributing no force — these are different questions.
    hitThresholdCompute: 0,   // positive edges exert force only if weight >= this
    missThresholdCompute: 0,  // negative edges exert force only if weight <= this
    hitThresholdDraw: 0,      // positive edges drawn when weight >= this
    missThresholdDraw: 0,     // negative edges drawn when weight <= this
    lockAttractionRepulsion: true,
    // What the canvas is a picture of ([D View.1]). The first reads the
    // *input*, the other two read the *output* — the layout the run produced,
    // which is a lossy projection of those same weights into two dimensions,
    // and therefore says something the weights alone do not.
    //
    // 'relations' — every edge, both signs, straight from the input weights:
    //               what actually drives the layout.
    // 'proximity' — every pair of nodes lying within proximityMaxDistance of
    //               each other *in space*, recomputed from the current
    //               positions, minus the pairs the input calls a miss: what
    //               ended up near what, and what ended up near nothing.
    // 'clusters'  — the same proximity graph with its long edges cut, drawn
    //               by connected component: which groups the layout found.
    //
    // The last two are only offered while the simulation is stopped
    // ([D View.2]) — they describe a layout, and a moving one is not yet a
    // layout to describe.
    viewMode: 'relations',
    // Which embedding the canvas shows ([D Globe.1]): 'plane' — the unit disk
    // every earlier version drew — or 'globe' (default), the same graph laid
    // out on the surface of a sphere. Both layouts exist and are stepped
    // together whenever the simulation runs, so this switches what you are
    // looking at and nothing else: no run restarts, no state changes, and the
    // relations/proximity reading in force carries across untouched
    // ([D Globe.6]).
    geometry: 'globe',
    // Together these two are how a host *forces* a geometry: set the one it
    // wants and hide the control, and the widget can never leave it — nothing
    // inside writes config.geometry except the toggle itself. Same pairing as
    // showViewModeToggle ([D View.3]), and with less to guard, since there is
    // no automatic geometry switch to gate: the only rule that moves a
    // geometry is a click on the button that is no longer there.
    showGeometryToggle: true,
    // The radius that *defines* the 'proximity' reading ([D View.9]), in world
    // units — the layout lives in a disk of radius 1, so 0.2 is a tenth of its
    // diameter. Two nodes are joined exactly when they lie within it of each
    // other. There is no k: "who are this node's k nearest neighbours" always
    // has an answer, so a lone node was drawn reaching across the disk to the
    // pack, while "who is within radius" can answer nobody — which is the only
    // way an outlier gets drawn as one ([D View.12]).
    //
    // 0 or less is an empty reading, not an unbounded one: with the radius
    // gone there is no question left to answer, and the alternative reading of
    // "no limit" is the complete graph.
    proximityMaxDistance: 0.2,
    // The same radius for the globe, and it has to be its own field rather
    // than the same number reused ([D Globe.9]). The unit sphere has area 4π
    // against the unit disk's π, so n nodes sit *exactly twice* as far apart
    // on it; a radius that finds six neighbours on the plane finds none at
    // all on the sphere, and the view came up empty. Twice the planar default
    // is therefore not a tuned number but the same number in the other
    // geometry's units — the identical factor already in
    // repulsionRadiusForGlobe().
    globeProximityMaxDistance: 0.4,
    // Edges longer than this quantile of the proximity graph's own length
    // distribution are cut before components are taken ([D View.6]). A
    // quantile rather than a distance because the layout is normalized to a
    // unit disk but its *internal* spacing is not: an absolute threshold
    // would mean something different on every graph.
    clusterQuantile: 0.8,
    showViewModeToggle: true,
    // uid search box with an autocomplete list, top-centre beside the two
    // toggles ([F Search.1]). Chrome like the rest of them, and switchable
    // like the rest of them ([D Config.3]): a host that would rather run its
    // own search turns this off and drives pin() itself ([F API.10]).
    showSearch: true,
    // Built-in Reset/Run/Pause/Force bar + state readout, top-right. A host
    // that would rather own those controls itself turns this off and drives
    // the instance through onStateChange (see createSimControls).
    showSimControls: true,
    // Node/edge counts, bottom-right in small grey type (statsReadout).
    showStats: true,
    // Accumulated running time, bottom-left, same treatment (timeReadout).
    showRunTime: true,
    // Cosmetic status feedback, each independently switchable — neither
    // touches the physics, only what the host chooses to show for it.
    showPulse: true,        // perimeter opacity animation while running (draw())
    showProgressBar: true,  // convergence-deadline bar anchored to the bottom (progressBar)
    // Keep only the k strongest edges per node (symmetric kNN sparsification).
    // Caps |E| at n*k — linear in node count — so cost per frame no longer
    // follows the quadratic edge growth of a dense similarity graph. 0 disables.
    maxEdgesPerNode: 15,
    // The engine works in a normalized unit disk: every node position stays in
    // [-1, 1] and the layout is re-fitted to radius 1 each frame, so none of the
    // parameters below carry a length unit — they are all dimensionless ratios
    // and never need re-tuning for graph size. See normalizeToUnitDisk().
    physics: {
      restLength: 1,        // optimal edge length = restLength * (1 - weight), in [0, 2] = disk diameter
      attraction: 1,
      repulsion: 1,
      repulsionSpacing: 1.2, // crowding radius = repulsionSpacing / sqrt(nodeCount)
      epsilonStart: 0.005,
      epsilonMax: 0.05,
      epsilonDelta: 0.001,
      damping: 0.75,
      maxStep: 0.05,        // hard cap on per-frame displacement, in disk radii
      stopVelocity: 0.0004, // mean per-frame displacement below which the layout is settled
      stopFrames: 40,
      // Same criterion, but applied only while in the `forced` state (the user
      // asked to continue past a convergence already reached). Deliberately
      // stricter than stopVelocity: the layout has already stopped once by the
      // normal standard, so re-applying that standard would settle it again
      // within stopFrames and make forceContinue() a no-op. The forced run has
      // no cap ([F Phys.4] is waived), so this threshold is the *only*
      // thing that ends it.
      forcedStopVelocity: 0.0001,
      // Convergence guarantee, in two units ([D Phys.3]). Whichever runs out
      // first forces the layout to settle on the spot; either at 0 is off,
      // both at 0 lets a run go as long as it takes. Both are budgets for the
      // *current* run and both are waived in 'forced' ([F API.4]) — Force is
      // how a user asks for a run these limits do not apply to.
      //
      // They bound different things and are not redundant. Seconds bound what
      // the user waits: a promise the widget can actually keep, since it is
      // measured in the unit the user is counting in. Steps bound the work
      // done: they keep a fast machine from doing several times the layout of
      // a slow one for the same wait, and — being the unit the layout is a
      // deterministic function of ([F Det.1]) — they are what makes a capped
      // run land in the same place twice.
      //
      // Which one fires is therefore a property of the machine, and that is
      // deliberate: it is the *result* that varies with the machine, not the
      // waiting, and a smarter store than this library decides what to keep
      // ([D Phys.3], [Opn 3]). `reason` tells the two endings apart.
      //
      // Measured against runElapsedMs, not wall-clock: the budget is spent
      // only while actually stepping, so pausing does not consume it.
      //
      // At these defaults the seconds budget is what ends a run on any machine
      // below 1440 steps/s, and 7200 (the old 120-second default at 60fps) is
      // the backstop that still bounds a run for a host that sets seconds to 0
      // — deliberately, since it is the reproducible ending and the one to
      // fall back on. demo.html lowers frames instead, to a value the two
      // budgets actually compete over.
      maxConvergenceSeconds: 5,
      maxConvergenceFrames: 7200
    },
    style: {
      backgroundColor: '#ffffff',
      // Outside the boundary circle — a tone close enough to backgroundColor
      // to read as "the same page continuing", not a boxed-in widget.
      outsideColor: '#f8f8fe',
      perimeterColor: '#000000',
      perimeterWidth: 1,
      // Perimeter opacity communicates simulation status at a glance: a flat
      // resting alpha while idle (loaded, not yet started) — the circle the
      // layout is about to leave, drawn from the first frame; pulsing while
      // running (a heartbeat, fixed rate and fixed min/max — tying either to
      // the engine's movement was tried and rolled back, not worth the extra
      // moving parts); and, once converged, eased down to the quieter
      // perimeterSettledAlpha below — faint rather than gone, since settled
      // is exactly when someone is reading the disk.
      // While paused mid-layout there is no separate value: the pulse clock
      // (accumulated running time, see tick()) freezes the instant pause() is
      // called, so the perimeter just holds whatever alpha it last had —
      // visible, and exactly continuous with what resuming shows a frame
      // later.
      //
      // The idle alpha is the pulse's own value at t = 0 (sin 0 -> phase 0.5,
      // the midpoint of min/max), so Run picks the heartbeat up from exactly
      // the alpha already on screen rather than stepping to it.
      perimeterIdleAlpha: 0.5,
      perimeterPulseSpeed: 0.5,
      perimeterPulseMinAlpha: 0.2,
      perimeterPulseMaxAlpha: 0.8,
      // Non-zero, so the disk keeps an edge once the layout stops — which is
      // when someone is actually reading it — and the settled transition
      // becomes the pulse easing to a halt rather than the boundary fading
      // out from under the graph. Set just *under* the pulse's floor
      // (perimeterPulseMinAlpha, 0.2) rather than at it: still legible, but
      // quieter than anything the running state ever shows, so "stopped"
      // stays the faintest the perimeter gets without becoming absent. A host
      // that does want it gone sets 0.
      perimeterSettledAlpha: 0.15,
      // On the exact frame convergence is reached, the perimeter eases from
      // wherever the pulse happened to be at that instant down/up to
      // perimeterSettledAlpha, and the outside-disk area eases from
      // backgroundColor towards outsideColor — both over
      // settledTransitionDuration ms, no separate "last pulse" spike. The
      // same easing runs in reverse the moment convergence is lost again (a
      // fresh generate/restart/load while settled): the outer tint fades
      // back towards backgroundColor instead of cutting instantly. See
      // draw()/tick() (settledAt/unsettledAt).
      settledTransitionDuration: 600,
      nodeColor: '#000000',
      nodeRadius: 1.5,
      // Beyond a given zoom level (expressed as a multiple of baseZoom, the
      // zoom that fits the whole disk in the viewport — same reference used
      // by clampZoom — so this scales with viewport size like everything
      // else camera-related) nodes grow when zoomed in and shrink when
      // zoomed out, readability cues in either direction. Applies in every
      // lifecycle state — zoom is the only thing that changes node size.
      // Outside the band [zoomOutThreshold, zoomInThreshold] — both expressed
      // as multiples of baseZoom — node radius follows zoom as a power law,
      // `nodeRadius * (zoomRatio / threshold) ^ exponent`, clamped to
      // [nodeRadiusMin, nodeRadiusMax].
      //
      // The exponents are what keeps the wheel smooth. Each branch's ratio is
      // exactly 1 at its own threshold, so the power is 1 and the radius
      // equals nodeRadius there: the curve *leaves* the plateau rather than
      // jumping off it. Plain multipliers were tried first and are wrong for
      // this — a factor applies in full the instant the threshold is crossed,
      // which is a visible pop under a continuously-scrolling wheel.
      //
      // 0.5 (square root) rather than 1 (proportional): zoom clamps at 250x
      // the fit-to-view level, where anything near-linear balloons almost
      // immediately. 0 would disable the effect and pin the radius flat.
      nodeRadiusZoomInThreshold: 3,
      nodeRadiusZoomInExponent: 0.5,
      nodeRadiusMax: 5,
      nodeRadiusZoomOutThreshold: 0.5,
      nodeRadiusZoomOutExponent: 0.5,
      nodeRadiusMin: 1,
      nodeBorderWidth: 1,
      nodeBorderColor: '#000000',
      // Hovered node: same border as a normal node by default, white fill so
      // it reads as "punched out" against the surrounding graph.
      highlightColor: '#ffffff',
      highlightBorderWidth: 1.5,
      highlightBorderColor: '#000000',
      highlightRadius: 5,
      // Relation sign is carried by hue, strength by opacity: |weight| drives
      // alpha, so a weak relation reads as a faint tint and a full one as solid
      // colour. Encoding strength in the colour *channel* instead would render
      // weak edges near-black on a light background — the exact opposite of the
      // intended reading.
      hitEdgeColor: '0,0,255',   // positive correlation
      missEdgeColor: '255,0,0',  // negative correlation
      edgeWidth: 1,
      missEdgeWidth: 1,
      // |weight| 0 → alpha 0, |weight| 1 → alpha max. Capping well below 1 keeps
      // dense edge bundles readable; the miss cap is the lower of the two to
      // offset the fact that negative edges are long, and so cover more pixels.
      maxHitAlpha: 0.25,
      maxMissAlpha: 0.15,
      minEdgeAlpha: 0,

      // --- 'proximity' / 'clusters' ------------------------------------
      // Deliberately not blue: in 'relations' blue means "positive input
      // weight", and a proximity edge is a different claim entirely — it says
      // these two ended up near each other, whatever the input asked for.
      // Reusing the hue would make the toggle look like a filter, which is
      // exactly what the old neighbors view was.
      proximityEdgeColor: '0,140,120',
      proximityEdgeAlpha: 0.15,
      // Width carries the input weight ([D View.11]). proximityEdgeWidth is
      // the baseline — a pair the data says nothing about, or says something
      // barely above hitThresholdDraw — and proximityEdgeMaxWidth is where a
      // weight of 1 lands. Alpha is *not* used for this: it is already spent
      // on keeping dense bundles readable, and a thin line at full opacity
      // and a thick one at half read as different strengths of the same
      // stroke, which is the comparison wanted.
      proximityEdgeWidth: 1,
      proximityEdgeMaxWidth: 3,

      // --- 'globe' -----------------------------------------------------
      // Depth cue ([D Globe.5]). Everything on the sphere is drawn, front and
      // back alike, with opacity falling off towards the far side: this is the
      // *floor* of that ramp, against 1 at its ceiling. Neither end is a value
      // anything is actually painted at — depthAlpha() takes the ramp at each
      // slab's midpoint, so at six slabs the far one comes out at 0.19 and the
      // near one at 0.93. Not zero, because the far hemisphere is half the
      // graph and hiding it outright would mean the reading only ever showed
      // half of itself.
      globeDepthMinAlpha: 0.12,
      // Arc length, in radians, per tessellated segment of a surface path.
      // Edges are short by construction, so at 0.15 (~8.6°) most of them come
      // out as one or two segments and only the rare long one pays more.
      globeArcSegmentAngle: 0.15,
      // Hard cap on that tessellation, so a single antipodal edge cannot cost
      // an unbounded number of points.
      globeArcMaxSegments: 24,
      // The sphere's own coordinate grid ([D Globe.11]): meridians are lines
      // of longitude (pole to pole, half a great circle each), parallels lines
      // of latitude, evenly spaced and excluding the poles themselves — an odd
      // count therefore includes the equator, which is the one parallel that
      // is also a geodesic. 12 and 5 are both a line every 30°.
      //
      // Counts rather than a show/hide flag: 0 and 0 is off, and a flag beside
      // them would be a second way of saying the same thing, with the two free
      // to disagree. The grid is not data — it is drawn under the graph and
      // outside the palette rather than in it, so it cannot be misread as a
      // relation — and it takes the same depth fade as everything else on the
      // surface ([D Globe.5]), which is what makes it read as a sphere rather
      // than as a flat pattern.
      //
      // The colour is a pale tint of the chrome's ink, not the ink itself: the
      // grid has to sit below the faintest mark the graph can make, and at
      // full ink it was competing with the edges instead of holding still
      // behind them. Against the default white it lands near #efeff3 on the
      // near side — present when looked for, gone when not. The depth fade
      // then multiplies that down again towards the back, so the far half is
      // effectively absent; raise globeGraticuleAlpha to bring it up, or
      // darken the colour to make the whole grid assert itself.
      globeGraticuleMeridians: 12,
      globeGraticuleParallels: 5,
      globeGraticuleColor: '150,150,180',
      globeGraticuleAlpha: 0.16,
      globeGraticuleWidth: 1,

      // --- 'clusters' (parked, see [D View.6]) --------------------------
      // The view is not offered in the toggle: on real layouts it did not
      // add enough over the proximity graph to earn a third button. Everything
      // below still works — a host setting viewMode: 'clusters' through
      // updateConfig() gets it — and is kept so reviving it is re-enabling
      // one line in VIEW_MODES rather than rewriting the reading.
      clusterEdgeWidth: 1,
      // Hue is generated per cluster rather than read from a palette — the
      // count is not known in advance and any fixed list runs out.
      clusterSaturation: 0.55,
      clusterLightness: 0.45,
      clusterEdgeAlpha: 0.5,
      // Components smaller than this are not a cluster, just a few nodes that
      // happen to touch; drawn in this grey instead of taking a hue of their
      // own, so the coloured ones stay readable as the finding.
      clusterMinSize: 3,
      clusterOutlierColor: '170,170,180'
    }
  };

  // Event trace, behind config.logEvents ([D Config.7]). Five kinds, padded to
  // a common width so a run reads as columns rather than prose:
  //
  //   ui       a control in the widget was pressed
  //   api      a public method was called
  //   auto     the widget decided something on its own
  //   state    a lifecycle transition ([F State.1])
  //   cb       a host callback was invoked, with the payload it received
  //
  // The kind is what makes the trace worth having: 'ui' and 'api' land on the
  // same code, and which one arrived is exactly the question being asked when
  // a lifecycle bug is being chased. Refusals are not logged here — they go
  // to console.warn unconditionally ([D State.1]), being a misuse rather than
  // an event.
  //
  // The config object is read live rather than captured, so switching the
  // flag through updateConfig() takes effect on the next event.
  function createLogger(config) {
    var PAD = '     ';
    return function (kind, message, detail) {
      if (!config.logEvents) return;
      var label = '[Nodino] ' + (kind + PAD).slice(0, PAD.length) + ' ' + message;
      if (detail === undefined) console.log(label);
      else console.log(label, detail);
    };
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function deepMerge(target, source) {
    if (!source) return target;
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      if (isPlainObject(value)) {
        target[key] = deepMerge(isPlainObject(target[key]) ? target[key] : {}, value);
      } else {
        target[key] = value;
      }
    });
    return target;
  }

  function cloneDefaultConfig() {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  // ---------------------------------------------------------------------
  // Data — builds the internal sparse graph state from host input.
  // Node identity: `uid` (host-facing, [F Data.1]) is resolved here into
  // `nid` (array index, internal black-box, [F Data.2]) and never exposed
  // back to the host beyond this module.
  // ---------------------------------------------------------------------

  function buildGraphState(nodesInput, edgesInput, positionsInput, maxEdgesPerNode, globePositionsInput) {
    nodesInput = isPlainObject(nodesInput) ? nodesInput : {};
    edgesInput = Array.isArray(edgesInput) ? edgesInput : [];
    positionsInput = isPlainObject(positionsInput) ? positionsInput : {};
    globePositionsInput = isPlainObject(globePositionsInput) ? globePositionsInput : {};

    // uid set = keys of `nodes` ∪ every endpoint referenced by `edges`: a node
    // does not have to be declared explicitly if an edge already names it (it
    // just gets no metadata).
    var uidSet = new Set();
    Object.keys(nodesInput).forEach(function (uid) { uidSet.add(String(uid)); });

    // Edge tuples are validated and uid-interned here, but not yet resolved to
    // nid — the uid set (and therefore the nid assignment) is not final until
    // every edge has been scanned.
    var rawEdgesUid = [];
    for (var e = 0; e < edgesInput.length; e++) {
      var entry = edgesInput[e];
      if (!Array.isArray(entry) || entry.length < 3) continue;
      var ua = entry[0], ub = entry[1];
      if (ua == null || ub == null) continue;
      ua = String(ua); ub = String(ub);
      if (ua === ub) continue;
      var weight = Number(entry[2]);
      if (!isFinite(weight)) weight = 0;
      weight = Math.max(-1, Math.min(1, weight));
      uidSet.add(ua); uidSet.add(ub);
      rawEdgesUid.push([ua, ub, weight]);
    }

    // Deterministic nid assignment: sort the uid set lexicographically (UTF-16
    // code unit order, not localeCompare, so it does not depend on the
    // browser's locale) so `nid` — and therefore initial circle placement —
    // depends only on the input uid set, never on object/array iteration order.
    var uids = Array.from(uidSet);
    uids.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });

    var uidToNid = new Map();
    var metadata = [];
    for (var v = 0; v < uids.length; v++) {
      uidToNid.set(uids[v], v);
      var nodeEntry = nodesInput[uids[v]];
      metadata.push(nodeEntry && nodeEntry.m != null ? nodeEntry.m : null);
    }

    var count = uids.length;

    // Edges are kept as parallel arrays rather than one object per edge: at the
    // scales this has to survive (|E| in the 10^5–10^6 range for a dense
    // similarity graph) per-edge objects cost more in allocation and cache
    // misses than the whole physics step.
    var rawA = [], rawB = [], rawW = [];
    for (var r = 0; r < rawEdgesUid.length; r++) {
      rawA.push(uidToNid.get(rawEdgesUid[r][0]));
      rawB.push(uidToNid.get(rawEdgesUid[r][1]));
      rawW.push(rawEdgesUid[r][2]);
    }

    // Optional bootstrap positions (uid -> {x, y} in [-1, 1]), resolved to nid
    // space here since that mapping is only known at this point. A uid with no
    // matching node/edge is silently ignored — it named nothing in this graph.
    // Nodes left without an explicit position are flagged with NaN so
    // layoutInitial() knows to fall back to the deterministic circle formula
    // for them specifically (bootstrap can be partial).
    var initX = null, initY = null;
    var bootstrapCount = 0;
    var positionKeys = Object.keys(positionsInput);
    if (positionKeys.length > 0) {
      initX = new Float64Array(count);
      initY = new Float64Array(count);
      var hasInit = new Uint8Array(count);
      for (var pk = 0; pk < positionKeys.length; pk++) {
        var puid = positionKeys[pk];
        var pnid = uidToNid.get(puid);
        if (pnid === undefined) {
          console.warn('[Nodino] Position given for unknown uid "' + puid + '" — ignored.');
          continue;
        }
        var pos = positionsInput[puid];
        if (!pos || !isFinite(pos.x) || !isFinite(pos.y)) continue;
        initX[pnid] = Math.max(-1, Math.min(1, pos.x));
        initY[pnid] = Math.max(-1, Math.min(1, pos.y));
        hasInit[pnid] = 1;
      }
      for (var h = 0; h < count; h++) {
        if (hasInit[h]) bootstrapCount++;
        else { initX[h] = NaN; initY[h] = NaN; }
      }
    }

    // The same for the spherical layout ([D Globe.9]), from its own map and
    // kept strictly separate: the two layouts are different embeddings, not
    // two projections of one, so a host may cache either, both or neither and
    // each is honoured on its own terms. Positions are normalized back onto
    // the sphere on the way in rather than trusted — a cached vector that has
    // drifted off the unit radius, or arrived rounded from JSON, would
    // otherwise start the run slightly inside or outside the surface.
    var initGX = null, initGY = null, initGZ = null;
    var globeBootstrapCount = 0;
    var globeKeys = Object.keys(globePositionsInput);
    if (globeKeys.length > 0) {
      initGX = new Float64Array(count);
      initGY = new Float64Array(count);
      initGZ = new Float64Array(count);
      var hasGInit = new Uint8Array(count);
      for (var gk = 0; gk < globeKeys.length; gk++) {
        var guid = globeKeys[gk];
        var gnid = uidToNid.get(guid);
        if (gnid === undefined) {
          console.warn('[Nodino] Globe position given for unknown uid "' + guid + '" — ignored.');
          continue;
        }
        var gpos = globePositionsInput[guid];
        if (!gpos || !isFinite(gpos.x) || !isFinite(gpos.y) || !isFinite(gpos.z)) continue;
        var glen = Math.sqrt(gpos.x * gpos.x + gpos.y * gpos.y + gpos.z * gpos.z);
        if (!(glen > 1e-9)) continue;
        var gscale = UNIT_RADIUS / glen;
        initGX[gnid] = gpos.x * gscale;
        initGY[gnid] = gpos.y * gscale;
        initGZ[gnid] = gpos.z * gscale;
        hasGInit[gnid] = 1;
      }
      for (var gh = 0; gh < count; gh++) {
        if (hasGInit[gh]) globeBootstrapCount++;
        else { initGX[gh] = NaN; initGY[gh] = NaN; initGZ[gh] = NaN; }
      }
    }

    var kept = pruneTopKPerNode(rawA, rawB, rawW, count, maxEdgesPerNode);

    var edgeCount = kept.length;
    var edgeA = new Int32Array(edgeCount);
    var edgeB = new Int32Array(edgeCount);
    var edgeW = new Float64Array(edgeCount);
    for (var s = 0; s < edgeCount; s++) {
      var idx = kept[s];
      edgeA[s] = rawA[idx];
      edgeB[s] = rawB[idx];
      edgeW[s] = rawW[idx];
    }
    // Node degree is deliberately *not* precomputed here. It exists to turn
    // the per-node force sum into a mean ([F Phys.2]), so it has to count the
    // edges that actually contributed — and which those are depends on
    // hitThresholdCompute/missThresholdCompute, live config the engine
    // re-reads every step. A degree fixed at build time would keep dividing
    // by edges a raised threshold had just excluded, scaling every force down
    // as the threshold went up instead of filtering. step() counts it per
    // step instead, in the edge loop it is already running.

    return {
      count: count,
      uids: uids,
      // uid -> nid, the resolution table built above kept rather than dropped
      // ([F Data.2]). Everything internal works in nid, so this exists only
      // for the one direction that starts outside: a host naming a node by
      // uid ([F API.10]) and the search bar doing the same on its behalf
      // ([F Search.1]). Kept as the Map it already is instead of binary-
      // searching `uids` — the array is sorted, so the search would work, but
      // it would be a second way of answering a question already answered,
      // and the Map costs nothing that building it did not already cost.
      uidToNid: uidToNid,
      metadata: metadata,
      edgeCount: edgeCount,
      edgeA: edgeA,
      edgeB: edgeB,
      edgeW: edgeW,
      inputEdgeCount: rawA.length,
      initX: initX,
      initY: initY,
      // How many nodes arrived with a bootstrap position. Only the *complete*
      // case is load-bearing (see isCompleteLayout): a partial bootstrap is a
      // seed for a run, a complete one is a layout that has already been run.
      bootstrapCount: bootstrapCount,
      initGX: initGX,
      initGY: initGY,
      initGZ: initGZ,
      globeBootstrapCount: globeBootstrapCount,
      x: new Float64Array(count),
      y: new Float64Array(count),
      vx: new Float64Array(count),
      vy: new Float64Array(count),
      // Previous frame's positions — convergence is measured on actual movement
      // after normalization, not on raw velocity (see step()).
      px: new Float64Array(count),
      py: new Float64Array(count),
      // The spherical layout, a second and equally real embedding of the same
      // graph ([D Globe.1]). Kept beside the planar one rather than replacing
      // it because both are stepped every frame: switching geometry is then a
      // pure view change, with no layout restarted and no determinism traded
      // away ([D Globe.6]).
      globe: {
        x: new Float64Array(count),
        y: new Float64Array(count),
        z: new Float64Array(count),
        vx: new Float64Array(count),
        vy: new Float64Array(count),
        vz: new Float64Array(count),
        px: new Float64Array(count),
        py: new Float64Array(count),
        pz: new Float64Array(count)
      }
    };
  }

  // Deterministic sparsification: keep, for every node, only its `k` strongest
  // edges (a symmetric kNN graph — an edge survives if it is in the top-k of
  // either endpoint). This is the standard way to sparsify a similarity graph,
  // and it is what turns per-frame cost from O(n²) into O(n·k): a dense
  // similarity input relates ~a fixed fraction of all *pairs*, so |E| grows
  // quadratically with the node count while the useful structure does not.
  //
  // "Strongest" means largest |weight|, not largest weight: a strong negative
  // correlation carries as much information as a strong positive one, and
  // ranking by raw weight would systematically discard every repulsive edge.
  //
  // The ordering is a total order (|weight| desc → other endpoint asc → edge
  // index asc), so the surviving edge set depends only on the input, never on
  // iteration or sort-stability accidents.
  function pruneTopKPerNode(ea, eb, ew, nodeCount, k) {
    var m = ea.length;
    var all = [];
    var i;
    if (!(k > 0) || nodeCount === 0) {
      for (i = 0; i < m; i++) all.push(i);
      return all;
    }

    var keep = selectTopKPerNode(ea, eb, ew, nodeCount, k, new Uint8Array(m));
    for (i = 0; i < m; i++) if (keep[i]) all.push(i);
    return all;
  }

  // CSR-style adjacency over the edge arrays, built in O(E) without
  // allocating a list per node.
  function buildAdjacency(ea, eb, nodeCount) {
    var m = ea.length;
    var start = new Int32Array(nodeCount + 1);
    var i;
    for (i = 0; i < m; i++) {
      start[ea[i] + 1]++; start[eb[i] + 1]++;
    }
    for (i = 0; i < nodeCount; i++) start[i + 1] += start[i];

    var cursor = new Int32Array(nodeCount);
    var adj = new Int32Array(start[nodeCount]);
    for (i = 0; i < m; i++) {
      adj[start[ea[i]] + cursor[ea[i]]++] = i;
      adj[start[eb[i]] + cursor[eb[i]]++] = i;
    }
    return { start: start, adj: adj };
  }

  // Flags, in `out`, the k strongest edges of every node. Sparsification is
  // its only caller ([D Perf.1]): it used to be shared with the retired
  // neighbors view, which is what the `include` predicate both this and
  // buildAdjacency() carried was for — a filter no surviving caller ever set.
  function selectTopKPerNode(ea, eb, ew, nodeCount, k, out) {
    var csr = buildAdjacency(ea, eb, nodeCount);
    var slice = [];
    // One comparator for the whole pass, re-aimed at each node through the
    // `pivot` it closes over, rather than a fresh closure per node — at
    // 10^3-10^4 nodes that was one allocation per node for no gain. Inlined
    // rather than built by a factory so the node it ranks against is a plain
    // closed-over variable and not a call per comparison.
    //
    // Total order (|weight| desc -> other endpoint asc -> edge index asc), so
    // the surviving set never depends on sort stability.
    var pivot = 0;
    function comparator(p, q) {
      var mp = ew[p] < 0 ? -ew[p] : ew[p];
      var mq = ew[q] < 0 ? -ew[q] : ew[q];
      if (mp !== mq) return mq - mp;
      var op = ea[p] === pivot ? eb[p] : ea[p];
      var oq = ea[q] === pivot ? eb[q] : ea[q];
      if (op !== oq) return op - oq;
      return p - q;
    }
    for (var v = 0; v < nodeCount; v++) {
      var from = csr.start[v], to = csr.start[v + 1];
      if (to - from <= k) {
        for (var q = from; q < to; q++) out[csr.adj[q]] = 1;
        continue;
      }
      slice.length = 0;
      for (var r = from; r < to; r++) slice.push(csr.adj[r]);
      pivot = v;
      slice.sort(comparator);
      for (var s = 0; s < k; s++) out[slice[s]] = 1;
    }
    return out;
  }

  // Every node arrived with a bootstrap position, so `data.positions` was not
  // a seed for a layout but a layout — a converged one, restored from a cache
  // or handed over by whoever computed it ([D Data.3]). Coverage is the test
  // rather than mere presence: a partial bootstrap leaves the remaining nodes
  // on the default circle, which by construction is not a result.
  function isCompleteLayout(state) {
    return state.count > 0 && state.bootstrapCount === state.count;
  }

  // The same question for the sphere, and deliberately a *separate* one
  // ([D Globe.9]). It is not folded into isCompleteLayout() because that one
  // decides the lifecycle state, and requiring both would mean a host that
  // has never used the globe — and caches only what it uses — stopped getting
  // the settled-on-restore behaviour it has always had. So the plane governs
  // the state, and this governs only whether the sphere is finished too.
  function isCompleteGlobeLayout(state) {
    return state.count > 0 && state.globeBootstrapCount === state.count;
  }

  // The one and only length unit in the engine: the layout always lives inside
  // the circle of radius 1 centred on the origin.
  var UNIT_RADIUS = 1;

  // Distinct alpha levels used when drawing edges. Enough to keep the weight
  // gradient readable, few enough to batch every edge into a handful of paths.
  var ALPHA_BUCKETS = 8;

  // Distinct stroke widths used for proximity edges ([D View.11]). Fewer than
  // the alpha levels because the range is 2px wide: six levels is a step of
  // 0.4px, already below what reads as a difference at a glance.
  var WIDTH_BUCKETS = 6;

  // Depth slabs on the globe ([D Globe.5]). Serve two purposes at once, which
  // is why there is one number and not two: each slab is drawn at its own
  // globalAlpha, giving the fade, and the slabs are drawn far-to-near, giving
  // painter's-algorithm ordering without sorting anything. Six is enough that
  // the fade reads as continuous and few enough that the bucket count stays a
  // constant rather than a function of n.
  var DEPTH_BUCKETS = 6;

  // How far past the graph's edge the camera may be panned, as a fraction of
  // the visible half-extent of the axis in question — see clampPan(). One
  // constant for both axes: the viewport's aspect ratio is what makes the
  // horizontal range the wider of the two, so nothing here has to know about
  // aspect ratios at all.
  var PAN_SLACK = 0.35;

  // Pixels the projection's vertical center is nudged down by, so the graph
  // centers itself in the space *below* the top chrome (search box, geometry
  // toggle, view-mode toggle) rather than under it — centering in the full
  // viewport is centering half-behind that bar. Half of nodino.css's own top
  // strip (`top: 6px` plus one `--nodino-chrome-height: 28px` row), which is
  // as much of that CSS as this file needs to know: a fixed screen-space
  // offset, not a world one, so it holds steady regardless of zoom.
  var TOP_CHROME_OFFSET = 17;

  function layoutInitial(state) {
    var n = state.count;
    var angleStep = n > 0 ? (2 * Math.PI) / n : 0;
    // Deterministic PoC-style placement: node i (in nid order, i.e. uid-sorted —
    // see buildGraphState) sits at angle i * angleStep on the unit circle.
    // No randomness: same input uid set → same layout, every run. A node with
    // an explicit bootstrap position (state.initX/initY, see buildGraphState)
    // starts there instead — bootstrap can cover any subset of nodes, the rest
    // still get the circle.
    for (var i = 0; i < n; i++) {
      if (state.initX && !isNaN(state.initX[i])) {
        state.x[i] = state.initX[i];
        state.y[i] = state.initY[i];
      } else {
        var angle = i * angleStep;
        state.x[i] = Math.cos(angle) * UNIT_RADIUS;
        state.y[i] = Math.sin(angle) * UNIT_RADIUS;
      }
      state.vx[i] = 0;
      state.vy[i] = 0;
      state.px[i] = state.x[i];
      state.py[i] = state.y[i];
    }
    return UNIT_RADIUS;
  }

  // Crowding radius, relative to node density: n nodes spread over a unit disk
  // sit ~sqrt(pi/n) apart, so tying the radius to 1/sqrt(n) keeps the number of
  // neighbours each node repels roughly constant as the graph grows.
  function repulsionRadiusFor(n, phys) {
    return phys.repulsionSpacing / Math.sqrt(Math.max(n, 1));
  }

  // The same quantity on the sphere. The unit sphere has area 4π against the
  // unit disk's π, so n nodes sit ~sqrt(4π/n) apart — exactly twice as far —
  // and the crowding radius doubles with them. One factor, so that
  // repulsionSpacing keeps the same meaning in both geometries and the debug
  // panel's single field still governs both ([D Globe.2]).
  function repulsionRadiusForGlobe(n, phys) {
    return (2 * phys.repulsionSpacing) / Math.sqrt(Math.max(n, 1));
  }

  // The golden angle, 2π(1 − 1/φ). Already the spacing that keeps consecutive
  // cluster hues apart ([D View.6]); here it is what makes the Fibonacci
  // sphere below even rather than banded.
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  // Deterministic even placement on the sphere: the Fibonacci (golden-angle)
  // spiral. Node i takes the i-th of n equal-area horizontal bands and is
  // rotated by i golden angles, which distributes points with no clustering at
  // the poles and no visible seam — the two failure modes of the obvious
  // lat/lon nesting.
  //
  // The planar counterpart puts every node on the *rim* of the disk and lets
  // the physics pull the structure inwards. That has no analogue here: a sphere
  // has no rim, and the whole surface is equally "outside", so the honest
  // starting point is the uniform one. It is deterministic in exactly the same
  // sense ([F Det.1]) — nid order in, same sphere out, no randomness anywhere.
  //
  // The planar `positions` map is deliberately not consulted: it is 2-D, and
  // there is no non-arbitrary way to lift an (x, y) onto a sphere — any choice
  // is the projection [D Globe.8] rejects. A node restores from its *own*
  // geometry's cache (`globePositions`, state.initGX/GY/GZ) or from the spiral,
  // never from the other geometry's ([D Globe.9]); bootstrap can be partial,
  // and the nodes it does not cover fall back to their spiral slot.
  function layoutInitialGlobe(state) {
    var n = state.count;
    var g = state.globe;
    for (var i = 0; i < n; i++) {
      if (state.initGX && !isNaN(state.initGX[i])) {
        g.x[i] = state.initGX[i];
        g.y[i] = state.initGY[i];
        g.z[i] = state.initGZ[i];
      } else {
        var z = n > 1 ? 1 - (2 * (i + 0.5)) / n : 0;
        var r = Math.sqrt(Math.max(0, 1 - z * z));
        var theta = i * GOLDEN_ANGLE;
        g.x[i] = Math.cos(theta) * r * UNIT_RADIUS;
        g.y[i] = Math.sin(theta) * r * UNIT_RADIUS;
        g.z[i] = z * UNIT_RADIUS;
      }
      g.vx[i] = 0; g.vy[i] = 0; g.vz[i] = 0;
      g.px[i] = g.x[i]; g.py[i] = g.y[i]; g.pz[i] = g.z[i];
    }
    return UNIT_RADIUS;
  }

  // Puts a node back exactly on the sphere. This is the whole of the globe's
  // containment guarantee, and it replaces normalizeToUnitDisk() rather than
  // joining it: the disk needs a *global* re-fit because a plane has no
  // boundary of its own and the layout would otherwise drift and grow without
  // limit, whereas the sphere is compact — |p| = 1 is a per-node constraint,
  // it costs one sqrt, and it can never rescale the graph underneath the
  // camera ([D Globe.2]).
  function projectToSphere(g, i) {
    var len = Math.sqrt(g.x[i] * g.x[i] + g.y[i] * g.y[i] + g.z[i] * g.z[i]);
    if (len < 1e-12) {
      // Degenerate only if a node reached the exact centre, which the forces
      // cannot do on their own. Sent to a pole rather than left at zero, since
      // zero is the one point with no tangent plane at all.
      g.x[i] = 0; g.y[i] = 0; g.z[i] = UNIT_RADIUS;
      return;
    }
    var k = UNIT_RADIUS / len;
    g.x[i] *= k; g.y[i] *= k; g.z[i] *= k;
  }

  // Re-fits the layout into the unit disk: recentre on the centroid, then scale
  // so the farthest node sits exactly on radius 1. It is a similarity transform
  // (uniform scale + translation), so the graph's shape is untouched — only its
  // absolute size and position change. This is what makes the whole thing
  // scale-free: the physics may expand or collapse freely, the view never has to
  // chase it, and node coordinates provably stay in [-1, 1].
  function normalizeToUnitDisk(state) {
    var n = state.count;
    if (n === 0) return;

    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { cx += state.x[i]; cy += state.y[i]; }
    cx /= n; cy /= n;

    var maxSq = 0;
    for (var j = 0; j < n; j++) {
      var dx = state.x[j] - cx;
      var dy = state.y[j] - cy;
      state.x[j] = dx;
      state.y[j] = dy;
      var sq = dx * dx + dy * dy;
      if (sq > maxSq) maxSq = sq;
    }

    var maxR = Math.sqrt(maxSq);
    if (maxR < 1e-12) return; // single node, or all coincident: already centred
    var k = UNIT_RADIUS / maxR;
    for (var m = 0; m < n; m++) {
      state.x[m] *= k;
      state.y[m] *= k;
      // Velocities live in the same space and must follow the same scaling.
      state.vx[m] *= k;
      state.vy[m] *= k;
    }
  }

  // ---------------------------------------------------------------------
  // Spatial Index — uniform grid, rebuilt every physics step. Shared by
  // the repulsion pass ([F Phys.2]) and hover hit-testing (Interaction),
  // so both avoid scanning all nodes.
  // ---------------------------------------------------------------------

  // Because the layout is guaranteed to live inside the unit disk ([D Phys.2])
  // the grid's extent is known up front, so cells can be a flat array indexed by
  // (row, col) instead of a hash map. That removes the per-node string key the
  // map needed — at ~10 lookups per node per frame it was the single largest
  // source of allocation in the frame loop.
  function createGrid(cellSize) {
    var dim = 0;
    var start = null;   // CSR offsets into `items`, length dim*dim + 1
    var counts = null;  // per-cell counts, reused as write cursors
    var items = null;   // node ids grouped by cell

    function axisIndex(v) {
      return Math.floor((v + UNIT_RADIUS) / (api.cellSize > 0 ? api.cellSize : 1));
    }

    function clampAxis(i) {
      if (i < 0) return 0;
      if (i >= dim) return dim - 1;
      return i;
    }

    var api = {
      cellSize: cellSize,

      build: function (state) {
        var n = state.count;
        var size = api.cellSize > 0 ? api.cellSize : 1;
        var d = Math.max(1, Math.ceil((2 * UNIT_RADIUS) / size) + 1);
        if (d !== dim) {
          dim = d;
          start = new Int32Array(d * d + 1);
          counts = new Int32Array(d * d);
        } else {
          start.fill(0);
          counts.fill(0);
        }
        if (!items || items.length !== n) items = new Int32Array(n);

        var cellCount = counts.length;
        var i, cell;
        // A node can sit marginally outside the disk between integration and
        // re-normalization, hence the clamp.
        for (i = 0; i < n; i++) {
          cell = clampAxis(axisIndex(state.y[i])) * dim + clampAxis(axisIndex(state.x[i]));
          counts[cell]++;
        }
        var total = 0;
        for (i = 0; i < cellCount; i++) { start[i] = total; total += counts[i]; }
        start[cellCount] = total;

        counts.fill(0); // now write cursors
        for (i = 0; i < n; i++) {
          cell = clampAxis(axisIndex(state.y[i])) * dim + clampAxis(axisIndex(state.x[i]));
          items[start[cell] + counts[cell]++] = i;
        }
      },

      queryInto: function (x, y, out) {
        out.length = 0;
        if (dim === 0 || !start) return;
        var cx = axisIndex(x);
        var cy = axisIndex(y);
        for (var gy = cy - 1; gy <= cy + 1; gy++) {
          if (gy < 0 || gy >= dim) continue;
          var row = gy * dim;
          for (var gx = cx - 1; gx <= cx + 1; gx++) {
            if (gx < 0 || gx >= dim) continue;
            var cell = row + gx;
            for (var k = start[cell]; k < start[cell + 1]; k++) out.push(items[k]);
          }
        }
      }
    };

    return api;
  }

  // The same index one dimension up, for the spherical layout. Same CSR trick,
  // same 3-cells-a-side window (27 cells instead of 9), same guarantee: a
  // query radius no larger than the cell is fully covered.
  //
  // The cell count is dim³ rather than dim², and that is the one place the
  // globe costs real memory. Nodes occupy a *shell* inside that cube, so
  // occupancy stays O(n) and only the offset array pays the cube — but the
  // offset array is still allocated in full. GRID3_MAX_DIM caps it: past that
  // the cell is *widened* rather than the grid refused, which keeps the index
  // correct (a wider cell covers more, never less) and only makes the query
  // scan more candidates. That is a graceful, visible slowdown at very large
  // n instead of a hundred-megabyte allocation ([Rsk Globe.2]).
  var GRID3_MAX_DIM = 64;

  function createGrid3(cellSize) {
    var dim = 0;
    var start = null;
    var counts = null;
    var items = null;

    function axisIndex(v) {
      return Math.floor((v + UNIT_RADIUS) / (api.cellSize > 0 ? api.cellSize : 1));
    }

    function clampAxis(i) {
      if (i < 0) return 0;
      if (i >= dim) return dim - 1;
      return i;
    }

    var api = {
      cellSize: cellSize,

      build: function (g, n) {
        // The floor on the cell is applied here rather than at assignment, so
        // a caller can set cellSize freely and still never blow the budget.
        var minCell = (2 * UNIT_RADIUS) / (GRID3_MAX_DIM - 1);
        var size = api.cellSize > 0 ? Math.max(api.cellSize, minCell) : 1;
        api.cellSize = size;
        var d = Math.max(1, Math.min(GRID3_MAX_DIM, Math.ceil((2 * UNIT_RADIUS) / size) + 1));
        if (d !== dim) {
          dim = d;
          start = new Int32Array(d * d * d + 1);
          counts = new Int32Array(d * d * d);
        } else {
          start.fill(0);
          counts.fill(0);
        }
        if (!items || items.length !== n) items = new Int32Array(n);

        var cellCount = counts.length;
        var i, cell;
        for (i = 0; i < n; i++) {
          cell = (clampAxis(axisIndex(g.z[i])) * dim + clampAxis(axisIndex(g.y[i]))) * dim +
            clampAxis(axisIndex(g.x[i]));
          counts[cell]++;
        }
        var total = 0;
        for (i = 0; i < cellCount; i++) { start[i] = total; total += counts[i]; }
        start[cellCount] = total;

        counts.fill(0);
        for (i = 0; i < n; i++) {
          cell = (clampAxis(axisIndex(g.z[i])) * dim + clampAxis(axisIndex(g.y[i]))) * dim +
            clampAxis(axisIndex(g.x[i]));
          items[start[cell] + counts[cell]++] = i;
        }
      },

      queryInto: function (x, y, z, out) {
        out.length = 0;
        if (dim === 0 || !start) return;
        var cx = axisIndex(x), cy = axisIndex(y), cz = axisIndex(z);
        for (var gz = cz - 1; gz <= cz + 1; gz++) {
          if (gz < 0 || gz >= dim) continue;
          var plane = gz * dim;
          for (var gy = cy - 1; gy <= cy + 1; gy++) {
            if (gy < 0 || gy >= dim) continue;
            var row = (plane + gy) * dim;
            for (var gx = cx - 1; gx <= cx + 1; gx++) {
              if (gx < 0 || gx >= dim) continue;
              var cell = row + gx;
              for (var k = start[cell]; k < start[cell + 1]; k++) out.push(items[k]);
            }
          }
        }
      }
    };

    return api;
  }

  // Chord length of a geodesic arc on the unit sphere, and its inverse. The
  // spatial index measures straight-line distance in R³ while every distance
  // the reading talks about is measured *along the surface*; the two are
  // related by chord = 2·sin(θ/2), which is monotone, so a chord-radius query
  // is exactly a geodesic-radius query with the threshold converted once. That
  // is what lets the index stay flat and Euclidean while the semantics stay
  // spherical ([D Globe.3]).
  function chordFromArc(theta) {
    if (!(theta > 0)) return 0;
    if (theta >= Math.PI) return 2 * UNIT_RADIUS;
    return 2 * UNIT_RADIUS * Math.sin(theta / 2);
  }

  // ---------------------------------------------------------------------
  // Output readings — 'proximity' and 'clusters' ([D View.5], [D View.6]).
  //
  // Everything here is computed from the *current positions*, not from the
  // input weights, which is the whole point: the layout is a lossy projection
  // of those weights into two dimensions, and what survived the projection is
  // information the weights do not carry. Two nodes the data relates strongly
  // but the layout had to push apart — because every other constraint pulled
  // elsewhere — is a fact only these readings can show.
  //
  // All of it runs once, on entering the view, never per frame: the views are
  // offered only while the simulation is stopped ([D View.2]), so the
  // positions they read cannot change underneath them. Cost is one grid build
  // plus O(n + P) for the neighbourhood, P being the pairs it finds, with a
  // sort of those P lengths for clusters.
  // ---------------------------------------------------------------------

  // The radius neighbourhood of the current layout: every pair of nodes lying
  // within `radius` of each other, and nothing else ([D View.9]).
  //
  // This replaced a kNN, and the two are not variations on one idea. "Who are
  // this node's k nearest neighbours" always has an answer — a node alone on
  // the rim still has ten of them, drawn reaching across empty space — while
  // "who is within radius" can answer *nobody*, which is the only way an
  // isolated node can be drawn as isolated. The cost is that the answer is no
  // longer bounded per node: in a dense pocket a node is joined to everything
  // around it, and that is the reading, not a defect — edge density there is
  // local node density, stated structurally.
  //
  // Symmetric for free, unlike the kNN: d(i,j) <= radius is a symmetric
  // predicate, so there is no top-k-of-either-endpoint rule to impose. Each
  // pair is emitted once, deduped through `seen`, and the result depends only
  // on the positions ([F Det.1]) — grid insertion order affects the order of
  // the emitted list, never its contents.
  //
  // Each pair also carries the *input* weight relating its two endpoints, or
  // 0 where the input relates them not at all. That is what lets the view drop
  // the pairs the data calls a miss and thicken the ones it calls a strong hit
  // ([D View.11]) — the reading stays an output reading, since which pairs
  // appear at all is decided purely by the layout, but each one can say what
  // the input thought of it.
  //
  // O(n + P) after the grid build, where P is the number of pairs found. P is
  // quadratic in n at a fixed radius, which is a property of the question and
  // not of this implementation — see [Rsk View.2].
  // Pair -> input weight, over the edges that survived sparsification — the
  // same set 'relations' draws, so the two views cannot disagree about what
  // the data says. One O(E) pass and O(1) lookups, against a rescan of the
  // edge list per pair. Shared by both geometries: the weights are the input,
  // and the input does not know which embedding is on screen.
  function pairWeightMap(state) {
    var n = state.count;
    var weightOf = new Map();
    for (var we = 0; we < state.edgeCount; we++) {
      var wa = state.edgeA[we], wb = state.edgeB[we];
      weightOf.set((wa < wb ? wa : wb) * n + (wa < wb ? wb : wa), state.edgeW[we]);
    }
    return weightOf;
  }

  function computeProximity(state, radius) {
    var n = state.count;
    var empty = {
      count: 0, a: new Int32Array(0), b: new Int32Array(0),
      len: new Float64Array(0), w: new Float64Array(0)
    };
    if (n < 2 || !(radius > 0)) return empty;

    var weightOf = pairWeightMap(state);

    // Cell size *is* the radius, which makes the 3x3 query exact rather than
    // approximate: a node lies somewhere inside its own cell, so the window
    // extends at least `radius` past it on every side, and nothing within the
    // radius can fall outside the window. Nothing is missed and nothing needs
    // an expanding ring.
    //
    // The physics grid cannot serve even now: its cell tracks the crowding
    // radius (repulsionSpacing / sqrt(n)), which shrinks as the graph grows
    // and has nothing to do with this one — a 3x3 query there covers a
    // different distance on every graph.
    var grid = createGrid(radius);
    grid.build(state);

    var sx = state.x, sy = state.y;
    var r2 = radius * radius;

    var candidates = [];
    // Pair identity, packed as lo·n + hi — exact in a double for any node
    // count this library can reach.
    var seen = new Set();
    var ea = [], eb = [], el = [], ewt = [];

    for (var i = 0; i < n; i++) {
      var qx = sx[i], qy = sy[i];
      grid.queryInto(qx, qy, candidates);

      for (var c = 0; c < candidates.length; c++) {
        var j = candidates[c];
        if (j === i) continue;
        var dx = sx[j] - qx, dy = sy[j] - qy;
        var d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        var lo = i < j ? i : j;
        var hi = i < j ? j : i;
        var key = lo * n + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        ea.push(lo); eb.push(hi); el.push(Math.sqrt(d2));
        ewt.push(weightOf.has(key) ? weightOf.get(key) : 0);
      }
    }

    return {
      count: ea.length,
      a: Int32Array.from(ea),
      b: Int32Array.from(eb),
      len: Float64Array.from(el),
      w: Float64Array.from(ewt)
    };
  }

  // The same reading on the sphere, and it is the same reading — `radius` is
  // still a distance along the surface, the pairs it admits are still every
  // pair closer than it, the weight lookup and the miss filter are untouched.
  // Only the metric moves: geodesic instead of straight-line ([D Globe.3]).
  //
  // The test itself is done in *chord* space. The index measures chords, the
  // threshold converts once through chordFromArc(), and because that map is
  // monotone the admitted set is bit-for-bit the set the geodesic test would
  // admit — with no acos in the inner loop. The recorded length is the arc,
  // because that is the quantity the reading means and the one `clusters`
  // takes a quantile of.
  function computeProximityGlobe(state, radius) {
    var n = state.count;
    var empty = {
      count: 0, a: new Int32Array(0), b: new Int32Array(0),
      len: new Float64Array(0), w: new Float64Array(0)
    };
    if (n < 2 || !(radius > 0)) return empty;

    var weightOf = pairWeightMap(state);
    var g = state.globe;

    var chord = chordFromArc(Math.min(radius, Math.PI));
    var grid = createGrid3(chord);
    grid.build(g, n);

    var gx = g.x, gy = g.y, gz = g.z;
    var c2 = chord * chord;

    var candidates = [];
    var seen = new Set();
    var ea = [], eb = [], el = [], ewt = [];

    for (var i = 0; i < n; i++) {
      var qx = gx[i], qy = gy[i], qz = gz[i];
      grid.queryInto(qx, qy, qz, candidates);

      for (var c = 0; c < candidates.length; c++) {
        var j = candidates[c];
        if (j === i) continue;
        var dx = gx[j] - qx, dy = gy[j] - qy, dz = gz[j] - qz;
        var d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > c2) continue;
        var lo = i < j ? i : j;
        var hi = i < j ? j : i;
        var key = lo * n + hi;
        if (seen.has(key)) continue;
        seen.add(key);
        // Chord back to arc: 2·asin(chord/2). Paid once per surviving pair,
        // not once per candidate.
        var half = Math.sqrt(d2) / (2 * UNIT_RADIUS);
        if (half > 1) half = 1;
        ea.push(lo); eb.push(hi); el.push(2 * UNIT_RADIUS * Math.asin(half));
        ewt.push(weightOf.has(key) ? weightOf.get(key) : 0);
      }
    }

    return {
      count: ea.length,
      a: Int32Array.from(ea),
      b: Int32Array.from(eb),
      len: Float64Array.from(el),
      w: Float64Array.from(ewt)
    };
  }

  // Connected components of the proximity graph once its long edges are cut.
  //
  // The cut is a *quantile* of the graph's own length distribution rather
  // than an absolute distance: the layout is normalized to a unit disk
  // ([D Phys.2]) but its internal spacing is not, so the same distance means
  // different things on a tight graph and a diffuse one, while "the longest
  // fifth of the proximity edges" means the same thing on both.
  function computeClusters(prox, nodeCount, quantile, minSize) {
    var labels = new Int32Array(nodeCount);
    var sizes = [];
    if (nodeCount === 0) return { labels: labels, sizes: sizes, threshold: 0 };

    // Float64Array.sort is numeric by default, unlike Array.sort.
    var lengths = Float64Array.from(prox.len);
    lengths.sort();
    var q = Math.max(0, Math.min(1, quantile));
    var threshold = lengths.length
      ? lengths[Math.min(lengths.length - 1, Math.floor(q * lengths.length))]
      : 0;

    var parent = new Int32Array(nodeCount);
    for (var p = 0; p < nodeCount; p++) parent[p] = p;

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]; // path halving
        x = parent[x];
      }
      return x;
    }

    for (var e = 0; e < prox.count; e++) {
      if (prox.len[e] > threshold) continue;
      var ra = find(prox.a[e]), rb = find(prox.b[e]);
      // Union by smaller root, so the representative of a component is a
      // function of its membership alone and not of merge order.
      if (ra === rb) continue;
      if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
    }

    // Labels handed out in ascending nid order of first appearance, so the
    // same layout always colours the same component the same way.
    var labelOfRoot = new Int32Array(nodeCount).fill(-1);
    for (var i = 0; i < nodeCount; i++) {
      var root = find(i);
      if (labelOfRoot[root] === -1) {
        labelOfRoot[root] = sizes.length;
        sizes.push(0);
      }
      labels[i] = labelOfRoot[root];
      sizes[labels[i]]++;
    }

    // Components too small to be a finding are marked -1 and drawn neutral,
    // so the coloured ones stay readable as the answer to "what groups are
    // there" rather than competing with a fog of pairs and singletons.
    var floor = Math.max(1, minSize);
    for (var m = 0; m < nodeCount; m++) {
      if (sizes[labels[m]] < floor) labels[m] = -1;
    }

    // Grouped up front, per component, because drawing needs it grouped: one
    // path per colour. Rebuilding these buckets inside draw() would allocate
    // an array per component and rescan every proximity edge on every frame
    // of a pan, for a reading that by construction cannot change while it is
    // on screen ([D View.2]). Outliers go in the -1 bucket, drawn neutral.
    var nodeGroups = {};
    for (var g = 0; g < nodeCount; g++) {
      (nodeGroups[labels[g]] || (nodeGroups[labels[g]] = [])).push(g);
    }
    var edgeGroups = {};
    for (var pe = 0; pe < prox.count; pe++) {
      if (prox.len[pe] > threshold) continue;
      var ea2 = prox.a[pe], eb2 = prox.b[pe];
      var la = labels[ea2];
      // Only intra-component edges, and never an outlier's: those are what
      // make a component read as a shape rather than as a recolouring.
      if (la < 0 || la !== labels[eb2]) continue;
      (edgeGroups[la] || (edgeGroups[la] = [])).push(ea2, eb2);
    }

    return {
      labels: labels,
      sizes: sizes,
      threshold: threshold,
      nodeGroups: toIntGroups(nodeGroups),
      edgeGroups: toIntGroups(edgeGroups)
    };
  }

  // {label: [nid, ...]} -> [{ label, items: Int32Array }], in ascending label
  // order so drawing order is a function of the data alone.
  function toIntGroups(map) {
    return Object.keys(map)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (label) {
        return { label: label, items: Int32Array.from(map[label]) };
      });
  }

  // Deterministic per-cluster hue. Generated rather than read from a palette:
  // the component count is not known in advance and any fixed list runs out.
  // The golden angle keeps consecutive labels far apart on the wheel, so
  // neighbouring clusters — which are the ones that must not be confused —
  // never land on adjacent hues.
  function clusterColor(label, saturation, lightness) {
    var hue = (label * 137.508) % 360;
    return 'hsl(' + hue.toFixed(1) + ',' +
      Math.round(Math.max(0, Math.min(1, saturation)) * 100) + '%,' +
      Math.round(Math.max(0, Math.min(1, lightness)) * 100) + '%)';
  }

  // ---------------------------------------------------------------------
  // Physics Engine — stress-majorization on sparse edges ([F Phys.1]) +
  // grid-based generic repulsion ([F Phys.2]) + damped integration with
  // auto-stop on convergence ([F Phys.3]), under a guarantee spent in two
  // units at once ([F Phys.4]). See [D Phys.3] for why neither unit subsumes
  // the other, and [Rsk Det.1] for the one thing the seconds budget costs.
  // ---------------------------------------------------------------------

  // `mode` is 'plane' or 'globe'. One engine shell, two step bodies: the
  // convergence bookkeeping, the epsilon ramp, the forced-mode regime and the
  // settle flags are identical in both geometries and are written once, while
  // the step itself is duplicated rather than parameterized.
  //
  // That split is deliberate. Every line of the step differs by a component —
  // three vectors instead of two, a tangent projection where the plane has a
  // global re-fit, a 27-cell query where the plane has 9 — so a shared body
  // would mean a branch or an indirection *per node per frame*, in the hot
  // loop, to save duplicating arithmetic. What must not diverge is the
  // convergence contract, and that is exactly the part that is shared.
  function createEngine(world, config, grid, mode) {
    var isGlobe = mode === 'globe';
    var epsilon = config.physics.epsilonStart;
    var settled = false;
    var stableFrames = 0;
    var fx = new Float64Array(0);
    var fy = new Float64Array(0);
    var fz = new Float64Array(0);
    // Per-step contributing degree, see the normalization pass in step().
    var deg = new Float64Array(0);
    var candidates = [];

    function ensureScratch(n) {
      if (fx.length !== n) {
        fx = new Float64Array(n);
        fy = new Float64Array(n);
        fz = new Float64Array(n);
        deg = new Float64Array(n);
      }
    }

    function reset() {
      epsilon = config.physics.epsilonStart;
      settled = false;
      stableFrames = 0;
    }

    // Shared tail of both step bodies: one movement measure, one threshold,
    // one stability counter. `moved` arrives already summed by the caller, in
    // whatever metric that geometry moves in — chord length on the sphere,
    // plain distance on the plane — which are the same units at the same
    // scale, both layouts living at radius 1.
    function recordMovement(moved, n, forcedMode) {
      var phys = config.physics;
      if (moved / n < (forcedMode ? phys.forcedStopVelocity : phys.stopVelocity)) {
        stableFrames++;
        if (stableFrames >= phys.stopFrames) settled = true;
      } else {
        stableFrames = 0;
      }
    }

    // `forcedMode` selects which convergence threshold applies this step:
    // physics.forcedStopVelocity while the host is in the `forced` state,
    // physics.stopVelocity otherwise. The caller (tick()) owns the state
    // machine, so it — not the engine — decides which regime we are in.
    function step(forcedMode) {
      if (settled) return false;

      var state = world.state;
      var n = state.count;
      if (n === 0) return false;
      var phys = config.physics;

      ensureScratch(n);
      if (isGlobe) return stepGlobe(state, n, phys, forcedMode);
      for (var i = 0; i < n; i++) { fx[i] = 0; fy[i] = 0; deg[i] = 0; }

      // Ramps towards epsilonMax and is pinned to it from either side: a plain
      // "only while below" ramp made *lowering* epsilonMax mid-run a silent
      // no-op once epsilon had already climbed past the new value — the one
      // case the debug panel's cold-field marking exists to prevent, on a
      // field that is otherwise read live.
      epsilon = Math.min(phys.epsilonMax, epsilon + phys.epsilonDelta);

      // --- Structural stress on sparse edges, O(E) ([F Phys.1]) ---------------
      // `optimal` lands in [0, 2] — exactly the unit disk's diameter range — so
      // weights map onto the available space without any length parameter.
      //
      // The |weight| factor is what makes weight 0 mean "no relation" rather
      // than "hold these two at distance restLength": without it a 0-weight
      // edge would pull just as hard as any other, and an explicit 0 would not
      // be equivalent to an absent edge. Strength now scales with how strongly
      // correlated the pair is, in either direction.
      var edgeA = state.edgeA, edgeB = state.edgeB, edgeW = state.edgeW;
      var px = state.x, py = state.y;
      var hitThresholdCompute = config.hitThresholdCompute;
      var missThresholdCompute = config.missThresholdCompute;
      for (var e = 0; e < state.edgeCount; e++) {
        var a = edgeA[e], b = edgeB[e];
        var w = edgeW[e];
        // Weight 0 is no relation at all, and has to be indistinguishable
        // from an absent edge ([D Data.2], [F Phys.1]). The |weight| factor
        // below already zeroes its force; the degree count is the other half
        // of that, and was the half that leaked. Left in the count it
        // inflated the divisor that turns the force sum into a mean
        // ([F Phys.2]), so a node's real edges pulled weaker for the company
        // of one that pulled not at all — and an explicit 0 was not, in fact,
        // equivalent to leaving the edge out. It also catches a malformed
        // input weight, which buildGraphState() turns into 0 on the way in:
        // a non-finite weight should cost its endpoints nothing, not damp
        // them.
        if (w === 0) continue;
        if (w > 0 && w < hitThresholdCompute) continue;
        if (w < 0 && w > missThresholdCompute) continue;
        var dx = px[b] - px[a];
        var dy = py[b] - py[a];
        var dist = Math.sqrt(dx * dx + dy * dy) || 1e-9;
        var optimal = phys.restLength * (1 - w);
        // Counted after the two threshold tests above, so it is the degree of
        // the edges that actually contribute — see buildGraphState.
        deg[a]++; deg[b]++;
        var stress = dist - optimal;
        // Negative edges push apart but never pull back: "maximally repulsive"
        // is an inequality (stay at least this far), not an equality (sit at
        // exactly the disk diameter). As an equality it is unsatisfiable for
        // more than one pair at a time — the constraints fight each other
        // forever and the layout never converges, so the engine keeps burning
        // a full step every frame instead of settling.
        if (w < 0 && stress > 0) stress = 0;
        stress *= w < 0 ? -w : w;
        stress *= stress < 0 ? phys.repulsion : phys.attraction;
        var s = stress / dist;
        var stepX = s * dx;
        var stepY = s * dy;
        fx[a] += stepX; fy[a] += stepY;
        fx[b] -= stepX; fy[b] -= stepY;
      }

      // Degree normalization: without it a node with 500 edges receives ~500x
      // the pull of a leaf, and the usable epsilon range would depend on |E|.
      // Dividing by degree turns the sum into a mean, so force magnitude is
      // bounded by the stress scale alone, whatever the graph's density.
      // Against the count accumulated above, not a build-time one: only the
      // edges that passed the compute thresholds are in the sum, so only they
      // belong in the divisor.
      for (var d0 = 0; d0 < n; d0++) {
        var dg = deg[d0];
        if (dg > 1) { fx[d0] /= dg; fy[d0] /= dg; }
      }

      // --- Generic crowding repulsion via the spatial grid ([F Phys.2]) ------
      var radius = repulsionRadiusFor(n, phys);
      for (var i2 = 0; i2 < n; i2++) {
        var xi = state.x[i2], yi = state.y[i2];
        grid.queryInto(xi, yi, candidates);
        var rx = 0, ry = 0, hits = 0;
        for (var c = 0; c < candidates.length; c++) {
          var j = candidates[c];
          if (j === i2) continue;
          var dx2 = xi - state.x[j];
          var dy2 = yi - state.y[j];
          var d = Math.sqrt(dx2 * dx2 + dy2 * dy2) || 1e-9;
          if (d >= radius) continue;
          var strength = (radius - d) / radius; // 1 when touching → 0 at the radius
          rx += (dx2 / d) * strength;
          ry += (dy2 / d) * strength;
          hits++;
        }
        // Mean, not sum: a node deep inside a dense cluster must not be shot out
        // just because it has more neighbours than one on the rim.
        if (hits > 0) {
          fx[i2] += (phys.repulsion * rx) / hits;
          fy[i2] += (phys.repulsion * ry) / hits;
        }
      }

      // --- Integration, with a hard per-frame displacement cap ---------------
      // The cap is what makes the layout stable for *any* parameter values: no
      // combination of attraction/repulsion/epsilon can move a node more than
      // maxStep disk radii in one frame, so the system can never blow up.
      var maxStep = phys.maxStep;
      for (var k = 0; k < n; k++) {
        var vx = (state.vx[k] + fx[k] * epsilon) * phys.damping;
        var vy = (state.vy[k] + fy[k] * epsilon) * phys.damping;
        var speed = Math.sqrt(vx * vx + vy * vy);
        if (speed > maxStep) {
          var t = maxStep / speed;
          vx *= t; vy *= t;
        }
        state.vx[k] = vx;
        state.vy[k] = vy;
        state.x[k] += vx;
        state.y[k] += vy;
      }

      // --- Re-fit into the unit disk (containment guarantee) ----------------
      normalizeToUnitDisk(state);

      // --- Convergence, measured on post-normalization movement -------------
      // Raw velocity would never settle here: a layout that keeps contracting
      // while normalization keeps re-expanding it has permanent velocity but
      // zero net movement. Comparing against the previous frame's positions
      // measures what actually changed on screen.
      var moved = 0;
      for (var p = 0; p < n; p++) {
        var mdx = state.x[p] - state.px[p];
        var mdy = state.y[p] - state.py[p];
        moved += Math.sqrt(mdx * mdx + mdy * mdy);
        state.px[p] = state.x[p];
        state.py[p] = state.y[p];
      }

      recordMovement(moved, n, forcedMode);
      return true;
    }

    // ------------------------------------------------------------------
    // The same four phases on the sphere ([D Globe.2]). Read it against
    // step() above: stress, repulsion, integration, convergence, in that
    // order, with three differences and no others.
    //
    //   1. Stress is measured along the surface. The distance between two
    //      nodes is the arc between their unit vectors, and the force on each
    //      endpoint points along that arc — which means *two* directions, one
    //      per tangent plane, where the plane could negate a single one.
    //   2. Repulsion stays in chord space. It is short-range by construction,
    //      chord and arc agree to third order there, and the force only has
    //      to point away — so paying an acos per candidate pair would buy
    //      precision the falloff curve immediately discards.
    //   3. Containment is per node and local: forces are projected onto the
    //      tangent plane before integration, and positions are put back on
    //      the sphere after it. No global re-fit, so nothing can rescale the
    //      graph under the camera between one frame and the next.
    // ------------------------------------------------------------------
    function stepGlobe(state, n, phys, forcedMode) {
      var g = state.globe;
      var i;
      for (i = 0; i < n; i++) { fx[i] = 0; fy[i] = 0; fz[i] = 0; deg[i] = 0; }

      epsilon = Math.min(phys.epsilonMax, epsilon + phys.epsilonDelta);

      var gx = g.x, gy = g.y, gz = g.z;

      // --- Structural stress, along the surface ---------------------------
      // `optimal` is an arc length. The planar version lands in [0, 2], the
      // disk's diameter; here the longest anything can be is π, half the way
      // round the sphere, so the same expression is scaled by π/2 and
      // restLength keeps its meaning in both geometries ([D Globe.4]).
      var edgeA = state.edgeA, edgeB = state.edgeB, edgeW = state.edgeW;
      var hitThresholdCompute = config.hitThresholdCompute;
      var missThresholdCompute = config.missThresholdCompute;
      for (var e = 0; e < state.edgeCount; e++) {
        var a = edgeA[e], b = edgeB[e];
        var w = edgeW[e];
        // Same exclusion as the plane, for the same reason: a zero-weight
        // edge exerts no force, so it must not be counted into the degree
        // that normalizes the ones that do.
        if (w === 0) continue;
        if (w > 0 && w < hitThresholdCompute) continue;
        if (w < 0 && w > missThresholdCompute) continue;

        var ax = gx[a], ay = gy[a], az = gz[a];
        var bx = gx[b], by = gy[b], bz = gz[b];
        var dot = ax * bx + ay * by + az * bz;
        if (dot > 1) dot = 1; else if (dot < -1) dot = -1;

        // Tangent at a pointing along the arc towards b, and vice versa. Both
        // degenerate exactly where the arc itself is undefined — coincident
        // and antipodal — and both are skipped there. Coincident pairs are
        // separated by the repulsion pass on the very next node loop; a truly
        // antipodal pair is already as far apart as the sphere allows, which
        // is what a negative edge wanted anyway.
        var tax = bx - dot * ax, tay = by - dot * ay, taz = bz - dot * az;
        var tbx = ax - dot * bx, tby = ay - dot * by, tbz = az - dot * bz;
        var tan = Math.sqrt(tax * tax + tay * tay + taz * taz);
        var tbn = Math.sqrt(tbx * tbx + tby * tby + tbz * tbz);
        if (tan < 1e-9 || tbn < 1e-9) continue;

        deg[a]++; deg[b]++;

        var theta = Math.acos(dot) * UNIT_RADIUS;
        var optimal = phys.restLength * (1 - w) * (Math.PI / 2);
        var stress = theta - optimal;
        // Same asymmetry as the plane: a negative edge pushes apart but never
        // pulls back, because "maximally repulsive" is an inequality and as an
        // equality it is unsatisfiable for more than one pair at a time.
        if (w < 0 && stress > 0) stress = 0;
        stress *= w < 0 ? -w : w;
        stress *= stress < 0 ? phys.repulsion : phys.attraction;

        var sa = stress / tan, sb = stress / tbn;
        fx[a] += sa * tax; fy[a] += sa * tay; fz[a] += sa * taz;
        fx[b] += sb * tbx; fy[b] += sb * tby; fz[b] += sb * tbz;
      }

      for (var d0 = 0; d0 < n; d0++) {
        var dg = deg[d0];
        if (dg > 1) { fx[d0] /= dg; fy[d0] /= dg; fz[d0] /= dg; }
      }

      // --- Generic crowding repulsion via the 3-D grid --------------------
      var radius = repulsionRadiusForGlobe(n, phys);
      for (var i2 = 0; i2 < n; i2++) {
        var xi = gx[i2], yi = gy[i2], zi = gz[i2];
        grid.queryInto(xi, yi, zi, candidates);
        var rx = 0, ry = 0, rz = 0, hits = 0;
        for (var c = 0; c < candidates.length; c++) {
          var j = candidates[c];
          if (j === i2) continue;
          var dx2 = xi - gx[j], dy2 = yi - gy[j], dz2 = zi - gz[j];
          var dd = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2) || 1e-9;
          if (dd >= radius) continue;
          var strength = (radius - dd) / radius;
          rx += (dx2 / dd) * strength;
          ry += (dy2 / dd) * strength;
          rz += (dz2 / dd) * strength;
          hits++;
        }
        if (hits > 0) {
          fx[i2] += (phys.repulsion * rx) / hits;
          fy[i2] += (phys.repulsion * ry) / hits;
          fz[i2] += (phys.repulsion * rz) / hits;
        }
      }

      // --- Integration on the tangent plane, then back onto the sphere -----
      var maxStep = phys.maxStep;
      var moved = 0;
      for (var k = 0; k < n; k++) {
        var px0 = gx[k], py0 = gy[k], pz0 = gz[k];

        // Radial component of the force removed: it would only fight the
        // projection below, and leaving it in makes maxStep meaningless —
        // the cap would be spent on motion that never survives the step.
        var fr = fx[k] * px0 + fy[k] * py0 + fz[k] * pz0;
        var ffx = fx[k] - fr * px0, ffy = fy[k] - fr * py0, ffz = fz[k] - fr * pz0;

        var vx = (g.vx[k] + ffx * epsilon) * phys.damping;
        var vy = (g.vy[k] + ffy * epsilon) * phys.damping;
        var vz = (g.vz[k] + ffz * epsilon) * phys.damping;

        // The carried velocity is tangent to where the node *was*, so it has
        // to be re-tangented to where it is before it is used again.
        var vr = vx * px0 + vy * py0 + vz * pz0;
        vx -= vr * px0; vy -= vr * py0; vz -= vr * pz0;

        var speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        if (speed > maxStep) {
          var t = maxStep / speed;
          vx *= t; vy *= t; vz *= t;
        }
        g.vx[k] = vx; g.vy[k] = vy; g.vz[k] = vz;
        g.x[k] = px0 + vx; g.y[k] = py0 + vy; g.z[k] = pz0 + vz;
        projectToSphere(g, k);

        // --- Convergence, on post-projection movement --------------------
        // Measured against the previous frame's position for the same reason
        // the plane measures it there: what matters is what changed on
        // screen, not what the velocity claimed.
        var mdx = g.x[k] - g.px[k], mdy = g.y[k] - g.py[k], mdz = g.z[k] - g.pz[k];
        moved += Math.sqrt(mdx * mdx + mdy * mdy + mdz * mdz);
        g.px[k] = g.x[k]; g.py[k] = g.y[k]; g.pz[k] = g.z[k];
      }

      recordMovement(moved, n, forcedMode);
      return true;
    }

    return {
      step: step,
      reset: reset,
      isSettled: function () { return settled; },
      // Convergence guarantee ([F Phys.4]): called from tick() once either
      // budget (physics.maxConvergenceSeconds / maxConvergenceFrames) is spent
      // without natural settlement. Same effect as reaching it organically — step()
      // becomes a no-op — just skipping the stopVelocity/stopFrames wait.
      forceSettle: function () { settled = true; },
      // Inverse of forceSettle(): resumes stepping past a convergence the
      // engine already reached, without a full reset() — epsilon and node
      // positions/velocities are untouched, only the settled flag and its
      // stability counter are cleared, so step() picks up exactly where it
      // left off instead of replaying the layout from scratch.
      forceUnsettle: function () { settled = false; stableFrames = 0; }
    };
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  // The two colour shapes the config accepts, and the only two validated:
  // a 6-digit hex for anything canvas takes whole, a bare RGB triplet for the
  // edge colours, which are interpolated into an 'rgba(...)' string per bucket.
  var HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
  var RGB_TRIPLET = /^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$/;

  function lerpHexColor(hexA, hexB, t) {
    // A value that is not 6-digit hex would make every parseInt below NaN and
    // produce 'rgb(NaN,NaN,NaN)' — which canvas rejects silently, leaving
    // whatever fill was set last and making the nodes vanish into the
    // background. Falling back to the other endpoint keeps the frame drawable.
    if (!HEX_COLOR.test(hexA)) return hexB;
    if (!HEX_COLOR.test(hexB)) return hexA;
    var ra = parseInt(hexA.slice(1, 3), 16), ga = parseInt(hexA.slice(3, 5), 16), ba = parseInt(hexA.slice(5, 7), 16);
    var rb = parseInt(hexB.slice(1, 3), 16), gb = parseInt(hexB.slice(3, 5), 16), bb = parseInt(hexB.slice(5, 7), 16);
    return 'rgb(' + Math.round(lerp(ra, rb, t)) + ',' + Math.round(lerp(ga, gb, t)) + ',' + Math.round(lerp(ba, bb, t)) + ')';
  }

  // ---------------------------------------------------------------------
  // Renderer — Canvas 2D, requestAnimationFrame-driven, sparse edges only,
  // pan/zoom viewport, viewport culling with a margin taken from the radius
  // actually painted ([F Render.1], [D Render.3]). There is no level of
  // detail beyond that cull: what keeps the frame affordable at |E| in the
  // 10^4-10^5 range is the bucketing, not dropping detail ([F Perf.1]).
  // ---------------------------------------------------------------------

  function createRenderer(canvas, world, config) {
    var ctx = canvas.getContext('2d');
    // `rot` is the world→camera rotation, row-major 3x3, and it is the only
    // piece of camera state the plane never touches. A matrix rather than a
    // quaternion because every frame needs the matrix and no frame needs to
    // interpolate: storing the quaternion would mean converting on every draw
    // to save an orthonormalization on every drag.
    var camera = { x: 0, y: 0, zoom: 1, rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
    // The two nodes that get a mark of their own: the one under the cursor and
    // the pinned one ([F Interact.3]). Two rather than one because they are
    // independent — hovering goes on while a pin holds, which is how a pin is
    // moved from one node to another — and because a node can be neither, one,
    // or (transiently) both.
    var highlighted = -1;
    var pinned = -1;
    // Zoom at which the whole unit disk fits the viewport. All zoom limits are
    // expressed as multiples of it, so they stay meaningful whatever the
    // viewport size — unlike absolute bounds, which assume a world scale.
    var baseZoom = 0;

    // Reused coordinate buffers: one alpha bucket per relation sign — indices
    // [0, ALPHA_BUCKETS) are positive edges, [ALPHA_BUCKETS, 2*ALPHA_BUCKETS)
    // negative ones. Allocated once and refilled in place, so drawing allocates
    // nothing per frame regardless of edge count.
    // On the globe every bucket set gains a depth slab as an outer index
    // ([D Globe.5]), so a bucket is (slab, level) rather than (level). On the
    // plane there is one slab and the indexing collapses to exactly what it
    // was — same arrays, same strides, same code path.
    var EDGE_STRIDE = ALPHA_BUCKETS * 2;
    var edgeBuckets = [];
    for (var bi = 0; bi < EDGE_STRIDE * DEPTH_BUCKETS; bi++) edgeBuckets.push({ coords: [], n: 0 });
    // Same idea for the proximity reading, bucketed by stroke width instead:
    // lineWidth is a property of the path, so a continuous width would cost
    // one stroke() per edge.
    var proximityBuckets = [];
    for (var pxi = 0; pxi < WIDTH_BUCKETS * DEPTH_BUCKETS; pxi++) proximityBuckets.push({ coords: [], n: 0 });
    // Nodes need one too, but only on the globe: the plane draws every node in
    // a single path straight off the state arrays and there is nothing to
    // improve on there.
    var nodeBuckets = [];
    for (var nbi = 0; nbi < DEPTH_BUCKETS; nbi++) nodeBuckets.push({ coords: [], n: 0 });
    // And the graticule ([D Globe.11]), by slab alone: it has one colour and
    // one width, so depth is the only thing that splits it into paths.
    var graticuleBuckets = [];
    for (var gbi = 0; gbi < DEPTH_BUCKETS; gbi++) graticuleBuckets.push({ coords: [], n: 0 });

    // Camera-space coordinates of the spherical layout, refilled once per
    // frame. Everything downstream — culling, bucketing, the edge and node
    // loops — then reads a pair of coordinate arrays exactly the way the
    // planar path reads state.x/state.y, which is what keeps one draw() for
    // two geometries instead of two draws.
    var projX = new Float64Array(0);
    var projY = new Float64Array(0);
    var projZ = new Float64Array(0);

    function isGlobe() {
      return config.geometry === 'globe';
    }

    function projectGlobe(state) {
      var n = state.count;
      if (projX.length !== n) {
        projX = new Float64Array(n);
        projY = new Float64Array(n);
        projZ = new Float64Array(n);
      }
      var g = state.globe, r = camera.rot;
      var r0 = r[0], r1 = r[1], r2 = r[2];
      var r3 = r[3], r4 = r[4], r5 = r[5];
      var r6 = r[6], r7 = r[7], r8 = r[8];
      var gx = g.x, gy = g.y, gz = g.z;
      for (var i = 0; i < n; i++) {
        var x = gx[i], y = gy[i], z = gz[i];
        projX[i] = r0 * x + r1 * y + r2 * z;
        projY[i] = r3 * x + r4 * y + r5 * z;
        // +Z towards the viewer, so the near hemisphere is the positive one
        // and the slab index below runs far → near with no reversal.
        projZ[i] = r6 * x + r7 * y + r8 * z;
      }
    }

    // Which depth slab a camera-space Z falls in: 0 is the far pole,
    // DEPTH_BUCKETS-1 the near one.
    function depthSlab(z) {
      var t = (z / UNIT_RADIUS + 1) / 2;
      var slab = Math.floor(t * DEPTH_BUCKETS);
      if (slab < 0) return 0;
      if (slab >= DEPTH_BUCKETS) return DEPTH_BUCKETS - 1;
      return slab;
    }

    // Opacity multiplier for a slab, taken at the slab's midpoint so the
    // extremes are not misrepresented by their own edges.
    function depthAlpha(slab) {
      var min = Math.max(0, Math.min(1, config.style.globeDepthMinAlpha));
      return min + (1 - min) * ((slab + 0.5) / DEPTH_BUCKETS);
    }

    // Appends one surface path to the current canvas path: the great-circle
    // arc between two nodes, tessellated ([D Globe.5]).
    //
    // Interpolation happens in *camera* space, on the already-projected
    // coordinates, which is exact rather than an approximation: rotation is
    // linear and orthogonal, so rotating the interpolant and interpolating the
    // rotated points are the same operation. The whole arc therefore costs no
    // rotations at all beyond the two endpoints the frame already projected.
    //
    // Normalized lerp rather than true slerp. They differ only in how points
    // are *spaced* along the arc, never in where the arc goes, and since the
    // segment count is chosen from the arc's own length the spacing error
    // stays well under a pixel. Slerp would buy nothing and cost two sines per
    // point.
    function appendArc(ia, ib, halfW, halfH, camX, camY, zoom) {
      var ax = projX[ia], ay = projY[ia], az = projZ[ia];
      var bx = projX[ib], by = projY[ib], bz = projZ[ib];
      ctx.moveTo(halfW + (ax - camX) * zoom, halfH + (ay - camY) * zoom);

      var dot = (ax * bx + ay * by + az * bz) / (UNIT_RADIUS * UNIT_RADIUS);
      if (dot > 1) dot = 1; else if (dot < -1) dot = -1;
      var theta = Math.acos(dot);
      var stepAngle = config.style.globeArcSegmentAngle;
      var segments = stepAngle > 0 ? Math.ceil(theta / stepAngle) : 1;
      var maxSegments = config.style.globeArcMaxSegments;
      if (segments > maxSegments) segments = maxSegments;
      if (!(segments > 1)) {
        // Short enough that the chord and the arc are the same line on
        // screen, which is the common case: the physics keeps edges short.
        ctx.lineTo(halfW + (bx - camX) * zoom, halfH + (by - camY) * zoom);
        return;
      }

      for (var s = 1; s <= segments; s++) {
        var t = s / segments;
        var mx = ax + (bx - ax) * t;
        var my = ay + (by - ay) * t;
        var mz = az + (bz - az) * t;
        var len = Math.sqrt(mx * mx + my * my + mz * mz);
        if (len > 1e-12) {
          var k = UNIT_RADIUS / len;
          mx *= k; my *= k;
        }
        ctx.lineTo(halfW + (mx - camX) * zoom, halfH + (my - camY) * zoom);
      }
    }

    // --- Graticule ([D Globe.11]) -----------------------------------------
    // The sphere's coordinate grid, as world-space polylines on the unit
    // sphere. It belongs to the *world*, not to the camera: it turns with the
    // graph, which is the whole reason it is worth drawing — a rotating sphere
    // of points has nothing in it that tells you it is rotating rather than
    // rearranging, and this does.
    //
    // The lines are built once per (meridians, parallels) pair and rotated per
    // frame, not rebuilt: they are fixed on the sphere, and only the camera
    // moves. That is a few thousand multiplies a frame against the 10^4–10^5
    // the edges already pay.
    //
    // Resolution is fixed rather than taken from globeArcSegmentAngle: that
    // knob trades smoothness against a per-edge cost paid |E| times, while
    // this is a handful of curves built once, so there is nothing to trade.
    // 96 segments to the full circle (3.75°) is finer than the edges get at
    // the default and costs nothing worth measuring.
    var GRATICULE_SEGMENTS = 96;
    var graticule = { meridians: -1, parallels: -1, lines: [] };

    function buildGraticule(meridians, parallels) {
      var lines = [];
      var i, k, lat, ca;

      // Poles on the world Y axis, which is the same axis the camera starts
      // upright on — an arbitrary frame, as it must be: the layout is a cloud
      // on a sphere and has no north of its own. The grid says how the sphere
      // is turned, not where anything is.
      var halfCircle = GRATICULE_SEGMENTS / 2;
      for (i = 0; i < meridians; i++) {
        var lon = (Math.PI * 2 * i) / meridians;
        var cl = Math.cos(lon), sl = Math.sin(lon);
        // Pole to pole — half a great circle, so the count is lines of
        // longitude in the cartographic sense and not whole circles.
        var mer = new Float64Array((halfCircle + 1) * 3);
        for (k = 0; k <= halfCircle; k++) {
          lat = -Math.PI / 2 + (Math.PI * k) / halfCircle;
          ca = Math.cos(lat);
          mer[k * 3] = UNIT_RADIUS * ca * cl;
          mer[k * 3 + 1] = UNIT_RADIUS * Math.sin(lat);
          mer[k * 3 + 2] = UNIT_RADIUS * ca * sl;
        }
        lines.push(mer);
      }

      for (i = 0; i < parallels; i++) {
        // Evenly spaced strictly between the poles: a parallel *at* one is a
        // point, not a line. With an odd count the middle one is the equator.
        lat = -Math.PI / 2 + (Math.PI * (i + 1)) / (parallels + 1);
        var py = UNIT_RADIUS * Math.sin(lat);
        var pr = UNIT_RADIUS * Math.cos(lat);
        var par = new Float64Array((GRATICULE_SEGMENTS + 1) * 3);
        for (k = 0; k <= GRATICULE_SEGMENTS; k++) {
          var ang = (Math.PI * 2 * k) / GRATICULE_SEGMENTS;
          par[k * 3] = pr * Math.cos(ang);
          par[k * 3 + 1] = py;
          par[k * 3 + 2] = pr * Math.sin(ang);
        }
        lines.push(par);
      }

      return lines;
    }

    function graticuleLines(meridians, parallels) {
      if (graticule.meridians !== meridians || graticule.parallels !== parallels) {
        graticule.lines = buildGraticule(meridians, parallels);
        graticule.meridians = meridians;
        graticule.parallels = parallels;
      }
      return graticule.lines;
    }

    // Drawn straight, segment by segment, rather than through appendArc: the
    // tessellation *is* the curve here — the polyline was built along it — so
    // there is nothing left to interpolate. Each segment takes the slab of its
    // own midpoint, exactly as an edge does, which is what fades the far half
    // of the grid and orders it behind the near half without sorting anything.
    //
    // The grid is drawn under the whole graph rather than interleaved with it
    // by slab. Interleaving would mean one merged far-to-near pass over four
    // kinds of element, for a gain of nothing visible: at this alpha a near
    // grid line under a far node is a faint line under a faint dot.
    function drawGraticule(halfW, halfH, camX, camY, zoom, bounds, margin) {
      var style = config.style;
      var meridians = Math.max(0, Math.floor(style.globeGraticuleMeridians) || 0);
      var parallels = Math.max(0, Math.floor(style.globeGraticuleParallels) || 0);
      var alpha = style.globeGraticuleAlpha;
      if (meridians + parallels === 0 || !(alpha > 0)) return;

      var lines = graticuleLines(meridians, parallels);
      var r = camera.rot;
      var r0 = r[0], r1 = r[1], r2 = r[2];
      var r3 = r[3], r4 = r[4], r5 = r[5];
      var r6 = r[6], r7 = r[7], r8 = r[8];

      var gi, bkt;
      for (gi = 0; gi < graticuleBuckets.length; gi++) graticuleBuckets[gi].n = 0;

      for (var li = 0; li < lines.length; li++) {
        var pts = lines[li];
        var px = 0, py = 0, pz = 0, hasPrev = false;
        for (var pi = 0; pi < pts.length; pi += 3) {
          var wx = pts[pi], wy = pts[pi + 1], wz = pts[pi + 2];
          var cx = r0 * wx + r1 * wy + r2 * wz;
          var cy = r3 * wx + r4 * wy + r5 * wz;
          var cz = r6 * wx + r7 * wy + r8 * wz;
          if (hasPrev && segmentInBounds(px, py, cx, cy, bounds, margin)) {
            bkt = graticuleBuckets[depthSlab((pz + cz) / 2)];
            var n = bkt.n, c = bkt.coords;
            c[n] = px; c[n + 1] = py; c[n + 2] = cx; c[n + 3] = cy;
            bkt.n = n + 4;
          }
          px = cx; py = cy; pz = cz; hasPrev = true;
        }
      }

      ctx.strokeStyle = 'rgba(' + style.globeGraticuleColor + ',' + alpha + ')';
      ctx.lineWidth = style.globeGraticuleWidth;
      for (var slab = 0; slab < DEPTH_BUCKETS; slab++) {
        bkt = graticuleBuckets[slab];
        if (bkt.n === 0) continue;
        ctx.globalAlpha = depthAlpha(slab);
        var co = bkt.coords;
        ctx.beginPath();
        for (var t = 0; t < bkt.n; t += 4) {
          ctx.moveTo(halfW + (co[t] - camX) * zoom, halfH + (co[t + 1] - camY) * zoom);
          ctx.lineTo(halfW + (co[t + 2] - camX) * zoom, halfH + (co[t + 3] - camY) * zoom);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Rotates the globe by a screen drag ([D Globe.7]). Horizontal drag spins
    // about the camera's vertical axis, vertical drag about its horizontal
    // one, both applied in *camera* space — which is what makes the surface
    // follow the cursor rather than the world spin about some fixed axis of
    // its own.
    //
    // The angle is the drag divided by the sphere's on-screen radius, so a
    // drag across the radius is about a radian whatever the zoom: the grab
    // stays on the same bit of surface instead of getting faster as you zoom
    // in.
    function rotateBy(dxScreen, dyScreen) {
      var screenRadius = world.perimeterRadius * camera.zoom;
      if (!(screenRadius > 0)) return;
      var a = dxScreen / screenRadius;
      var b = -dyScreen / screenRadius;

      var ca = Math.cos(a), sa = Math.sin(a);
      var cb = Math.cos(b), sb = Math.sin(b);
      // Rx(b) * Ry(a), written out rather than multiplied at runtime.
      var m = [
        ca, 0, sa,
        sb * sa, cb, -sb * ca,
        -cb * sa, sb, cb * ca
      ];

      var r = camera.rot;
      var out = new Array(9);
      for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          out[i * 3 + j] = m[i * 3] * r[j] + m[i * 3 + 1] * r[3 + j] + m[i * 3 + 2] * r[6 + j];
        }
      }
      camera.rot = orthonormalize(out);
    }

    // Gram-Schmidt, every drag. A rotation matrix multiplied a few thousand
    // times drifts off the orthogonal group in float64, and the visible
    // symptom is a globe that slowly shears — cheap to prevent, tedious to
    // diagnose later.
    function orthonormalize(m) {
      var ax = m[0], ay = m[1], az = m[2];
      var la = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      ax /= la; ay /= la; az /= la;

      var bx = m[3], by = m[4], bz = m[5];
      var d = ax * bx + ay * by + az * bz;
      bx -= d * ax; by -= d * ay; bz -= d * az;
      var lb = Math.sqrt(bx * bx + by * by + bz * bz) || 1;
      bx /= lb; by /= lb; bz /= lb;

      // Third row is forced to be the cross product of the first two, so the
      // frame stays right-handed and the globe can never come out mirrored.
      return [
        ax, ay, az,
        bx, by, bz,
        ay * bz - az * by,
        az * bx - ax * bz,
        ax * by - ay * bx
      ];
    }

    // The world-space point on the *near* surface under a screen position, or
    // null outside the silhouette. Exact, and exactly what hit-testing wants:
    // the far hemisphere is drawn but never picked, so a faded node behind the
    // globe cannot steal a hover from the solid one in front of it.
    function pickGlobe(screenX, screenY) {
      var cam = screenToWorld(screenX, screenY);
      var X = cam[0], Y = cam[1];
      var rSq = X * X + Y * Y;
      var limit = UNIT_RADIUS * UNIT_RADIUS;
      if (rSq > limit) return null;
      var Z = Math.sqrt(limit - rSq);
      // Camera → world is the transpose, the rotation being orthonormal.
      var r = camera.rot;
      return [
        r[0] * X + r[3] * Y + r[6] * Z,
        r[1] * X + r[4] * Y + r[7] * Z,
        r[2] * X + r[5] * Y + r[8] * Z
      ];
    }

    function computeBaseZoom(worldRadius) {
      var size = Math.min(canvas.width, canvas.height) || 600;
      return worldRadius > 0 ? (size * 0.45) / worldRadius : 1;
    }

    function resize() {
      var rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = Math.max(1, Math.round(rect.width));
      canvas.height = Math.max(1, Math.round(rect.height));
      var previousBase = baseZoom;
      baseZoom = computeBaseZoom(world.perimeterRadius);
      // Preserve how far the user had zoomed relative to the fitted view.
      if (previousBase > 0) camera.zoom *= baseZoom / previousBase;
      // The pan bound is derived from the viewport's own dimensions, so a
      // resize can move it under a camera that was legally placed a moment
      // ago — narrowing the window is enough. Without this the camera stays
      // out of bounds until the next drag or wheel notch happens to pull it
      // back in.
      clampPan();
    }

    // TOP_CHROME_OFFSET only holds if the top chrome it is compensating for
    // is actually there — a host that hides all three top-centre components
    // gets a canvas with nothing along its top edge, and centering below a
    // bar that was never drawn would just be off-center for no reason.
    function centerY() {
      var half = canvas.height / 2;
      return (config.showSearch || config.showGeometryToggle || config.showViewModeToggle)
        ? half + TOP_CHROME_OFFSET
        : half;
    }

    function worldToScreen(x, y) {
      return [
        canvas.width / 2 + (x - camera.x) * camera.zoom,
        centerY() + (y - camera.y) * camera.zoom
      ];
    }

    function screenToWorld(sx, sy) {
      return [
        camera.x + (sx - canvas.width / 2) / camera.zoom,
        camera.y + (sy - centerY()) / camera.zoom
      ];
    }

    // Where a node currently is on screen — the inverse of the hit-test, and
    // the one thing a pinned panel needs that interaction cannot work out for
    // itself ([D Interact.5]). On the globe the layout is 3-D, so the node
    // goes through the same camera rotation draw() applies; the depth is
    // dropped rather than tested, a node on the far side still projecting to
    // the point inside the silhouette where it is actually drawn, which is
    // where anything anchored to it belongs. Recomputed from `globe` rather
    // than read out of the projection cache draw() fills, so it is correct
    // when called between frames.
    function nodeScreenPos(nid) {
      var state = world.state;
      if (nid < 0 || nid >= state.count) return null;
      var wx, wy;
      if (isGlobe()) {
        var g = state.globe, r = camera.rot;
        var x = g.x[nid], y = g.y[nid], z = g.z[nid];
        wx = r[0] * x + r[1] * y + r[2] * z;
        wy = r[3] * x + r[4] * y + r[5] * z;
      } else {
        wx = state.x[nid];
        wy = state.y[nid];
      }
      return worldToScreen(wx, wy);
    }

    function visibleBounds() {
      var topLeft = screenToWorld(0, 0);
      var bottomRight = screenToWorld(canvas.width, canvas.height);
      return { minX: topLeft[0], minY: topLeft[1], maxX: bottomRight[0], maxY: bottomRight[1] };
    }

    function segmentInBounds(ax, ay, bx, by, bounds, margin) {
      if (Math.max(ax, bx) < bounds.minX - margin) return false;
      if (Math.min(ax, bx) > bounds.maxX + margin) return false;
      if (Math.max(ay, by) < bounds.minY - margin) return false;
      if (Math.min(ay, by) > bounds.maxY + margin) return false;
      return true;
    }

    // Node radius at the current zoom ([D Render.3]). Shared rather than
    // inlined in draw(), because hit-testing has to aim at the size actually
    // painted: computed from the base style.nodeRadius, the hover target
    // stayed at its unzoomed size while the node on screen grew to
    // nodeRadiusMax, so a zoomed-in node was visibly larger than the area
    // that would select it.
    function effectiveNodeRadius() {
      var style = config.style;
      var radius = style.nodeRadius;
      // Falling back to a ratio of 1 when baseZoom is unknown lands in the
      // flat band, entering neither branch.
      var zoomRatio = baseZoom > 0 ? camera.zoom / baseZoom : 1;
      if (zoomRatio > style.nodeRadiusZoomInThreshold) {
        radius = Math.min(style.nodeRadiusMax, radius * Math.pow(
          zoomRatio / style.nodeRadiusZoomInThreshold, style.nodeRadiusZoomInExponent
        ));
      } else if (zoomRatio < style.nodeRadiusZoomOutThreshold) {
        radius = Math.max(style.nodeRadiusMin, radius * Math.pow(
          zoomRatio / style.nodeRadiusZoomOutThreshold, style.nodeRadiusZoomOutExponent
        ));
      }
      return radius;
    }

    function pulseAlpha(timeMs) {
      var style = config.style;
      var cycle = (timeMs / 1000) * style.perimeterPulseSpeed;
      var phase = (Math.sin(cycle * Math.PI * 2) + 1) / 2; // 0..1
      return style.perimeterPulseMinAlpha +
        phase * (style.perimeterPulseMaxAlpha - style.perimeterPulseMinAlpha);
    }

    // The perimeter's "active" alpha — the animated pulse, or
    // (config.showPulse = false) the same flat resting look as idle with no
    // per-frame animation. Driven by *accumulated running time*
    // (tick()'s runElapsedMs), not wall-clock performance.now(): that clock
    // only advances while running and freezes the instant the sim pauses, so
    // reading it while paused naturally reproduces the exact phase the pulse
    // had at the moment of pausing — no separate "paused" value to store,
    // and resuming keeps advancing from that same frozen point with no
    // visible jump. Also shared by the entering-settled transition below, so
    // it always eases from whatever was actually on screen at that instant.
    function activeAlpha(runElapsedMs) {
      return config.showPulse ? pulseAlpha(runElapsedMs) : config.style.perimeterIdleAlpha;
    }

    function draw(status) {
      var state = world.state;
      var style = config.style;
      var hasPerimeter = world.perimeterRadius > 0;
      var center = hasPerimeter ? worldToScreen(0, 0) : null;
      var screenRadius = hasPerimeter ? world.perimeterRadius * camera.zoom : 0;
      var runElapsedMs = (status && status.runElapsedMs) || 0;

      // Simulation-status feedback, purely cosmetic — driven by wall-clock
      // time via performance.now(), which does not touch [F Det.1]/[Rsk Det.1]: the
      // physics step count (and thus the deterministic trajectory) never
      // depends on real elapsed time, only these unrelated stroke/fill
      // animations do.
      // outsideColor only ever shows up around a convergence event: eased in
      // on the way to settled, eased back out on the way off it (a fresh
      // generate/restart/load while settled) — never a flat tint while
      // running or idle.
      // Default rest alpha: perimeterIdleAlpha only before the graph has
      // ever been started; once started (running or paused alike), it's
      // activeAlpha() — see the comment above for why paused just works.
      var perimeterAlpha = (status && status.hasStarted) ? activeAlpha(runElapsedMs) : style.perimeterIdleAlpha;
      var outsideFill = style.backgroundColor;
      if (status && status.settled) {
        // Ease from wherever the pulse was at the instant convergence was
        // detected down/up to the resting alpha — no separate "last pulse"
        // spike. Once elapsed exceeds the duration this saturates to exactly
        // perimeterSettledAlpha, so there is no separate "fully settled"
        // branch to fall into.
        var elapsed = status.settledAt >= 0 ? performance.now() - status.settledAt : Infinity;
        var t = style.settledTransitionDuration > 0
          ? Math.max(0, Math.min(1, elapsed / style.settledTransitionDuration))
          : 1;
        // runElapsedMs stops advancing the instant settled becomes true, so
        // reading it here (any time during the transition) still yields
        // exactly the phase the pulse had at the moment of convergence.
        var startAlpha = activeAlpha(runElapsedMs);
        perimeterAlpha = lerp(startAlpha, style.perimeterSettledAlpha, t);
        outsideFill = lerpHexColor(style.backgroundColor, style.outsideColor, t);
      } else {
        // Mirror of the entering transition above: eases the outer tint back
        // towards backgroundColor instead of cutting it the instant a fresh
        // generate/restart/load flips settled back to false.
        if (status && status.unsettledAt >= 0) {
          var elapsedOut = performance.now() - status.unsettledAt;
          var tOut = style.settledTransitionDuration > 0
            ? Math.max(0, Math.min(1, elapsedOut / style.settledTransitionDuration))
            : 1;
          outsideFill = lerpHexColor(style.outsideColor, style.backgroundColor, tOut);
        }
      }

      // Outside the boundary circle is filled first, with whatever outsideFill
      // was resolved to above.
      ctx.fillStyle = outsideFill;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = style.backgroundColor;
      if (hasPerimeter) {
        ctx.beginPath();
        ctx.arc(center[0], center[1], screenRadius, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      var view = world.view;

      // Perimeter stroke — static circle at the initial layout radius (PoC parity: drawPerimeter).
      if (hasPerimeter) {
        ctx.globalAlpha = perimeterAlpha;
        ctx.strokeStyle = style.perimeterColor;
        ctx.lineWidth = style.perimeterWidth;
        ctx.beginPath();
        ctx.arc(center[0], center[1], screenRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Node size is resolved up here, before the cull margin, because the
      // margin has to cover it: a node whose centre falls just outside the
      // viewport still paints into it for one radius, so culling against a
      // margin narrower than the radius makes edge-of-screen nodes pop in and
      // out. That is why the margin is derived from the *effective* radius
      // rather than style.nodeRadius — with zoom-in growth capped well above
      // the base radius, the two are not interchangeable.
      //
      // Nodes are drawn the same way at every point in the lifecycle, the
      // states before the first Run included. 'empty'/'loaded' used to render
      // them as 1px borderless dots on the theory that the initial circle was
      // the only shape worth seeing there — but the circle is drawn in its own
      // right now (perimeterIdleAlpha), and the exception made a just-loaded
      // graph look like a different widget from the one a single click later.
      // Zoom-relative sizing: readability cue in both directions, past
      // thresholds expressed as multiples of baseZoom (see config comment).
      // Both branches are continuous at their own threshold — the ratio is
      // 1 there, so the power is 1 — which is what stops the wheel from
      // showing a pop as it crosses one.
      var nodeRadius = effectiveNodeRadius();
      var nodeBorderWidth = style.nodeBorderWidth;

      var bounds = visibleBounds();
      // Half the border straddles the outside of the circle, so the painted
      // extent is radius + half the stroke. Doubled for headroom, then
      // converted from screen pixels to world units.
      var margin = ((nodeRadius + nodeBorderWidth / 2) * 2) / camera.zoom;
      var hitThreshold = config.hitThresholdDraw;
      var missThreshold = config.missThresholdDraw;

      // Screen transform inlined below: worldToScreen() returns a fresh array,
      // which at 10^4–10^5 edges per frame is more allocation than drawing.
      var halfW = canvas.width / 2, halfH = centerY();
      var zoom = camera.zoom, camX = camera.x, camY = camera.y;

      // The one line that switches geometry for everything below: on the
      // globe the coordinate arrays are the camera-space projection, on the
      // plane they are the layout itself. Both are "where the node is on
      // screen, before pan and zoom", so nothing downstream has to ask which
      // it is — except where depth or curvature genuinely change the drawing.
      var globe = isGlobe();
      var sx = state.x, sy = state.y;
      if (globe) {
        projectGlobe(state);
        sx = projX; sy = projY;
      }
      var slabs = globe ? DEPTH_BUCKETS : 1;

      // The sphere's grid ([D Globe.11]), under everything the graph draws and
      // over the perimeter, which is that same sphere's silhouette — both are
      // at radius 1 ([D Globe.6]), so the two agree at the rim by construction
      // rather than by being kept in sync.
      if (globe) drawGraticule(halfW, halfH, camX, camY, zoom, bounds, margin);

      var isRelations = config.viewMode === 'relations';
      var isClusters = config.viewMode === 'clusters';

      // --- Proximity edges ('proximity') -----------------------------------
      // The radius neighbourhood of the current layout ([D View.5],
      // [D View.9]), short by construction. Two things are read off the input
      // weight of each pair,
      // and only those two — which pairs appear at all is still decided
      // purely by the positions.
      //
      // Misses are dropped, on the same threshold 'relations' uses. A line
      // between two nodes reads as a relation whatever the palette says, so
      // drawing one across a pair the data marks as a strong negative is the
      // single thing this view must not do — and it was doing it.
      //
      // Width carries the weight, from proximityEdgeWidth to
      // proximityEdgeMaxWidth ([D View.11]). Quantized into WIDTH_BUCKETS
      // levels for the same reason alpha is bucketed below: lineWidth is
      // per-path, so a continuous width would mean one stroke() per edge.
      // The levels are mapped to the ends of the range rather than to bucket
      // midpoints, so the thinnest really is proximityEdgeWidth and the
      // thickest really is proximityEdgeMaxWidth.
      if (config.viewMode === 'proximity' && view && view.proximity) {
        var prox = view.proximity;
        var pw0 = style.proximityEdgeWidth;
        var pw1 = Math.max(pw0, style.proximityEdgeMaxWidth);
        // Weight span above the hit threshold. Degenerate (threshold at or
        // above 1) means every hit is a top hit, so everything goes thick.
        var pSpan = 1 - hitThreshold;

        for (var pbi = 0; pbi < proximityBuckets.length; pbi++) proximityBuckets[pbi].n = 0;

        // No length test here: the radius is applied when the graph is built
        // ([D View.9]), so every pair in it is by definition inside it.
        for (var qe = 0; qe < prox.count; qe++) {
          var qw = prox.w[qe];
          if (qw < 0 && qw <= missThreshold) continue;
          var qa = prox.a[qe], qb = prox.b[qe];
          var qax = sx[qa], qay = sy[qa], qbx = sx[qb], qby = sy[qb];
          if (!segmentInBounds(qax, qay, qbx, qby, bounds, margin)) continue;

          var qt = pSpan > 0 ? (qw - hitThreshold) / pSpan : 1;
          if (!(qt > 0)) qt = 0; else if (qt > 1) qt = 1;
          // An edge takes the slab of its midpoint, which is what makes it
          // fade with the surface it lies on instead of with either end.
          var qslab = globe ? depthSlab((projZ[qa] + projZ[qb]) / 2) : 0;
          var qbk = proximityBuckets[qslab * WIDTH_BUCKETS + Math.round(qt * (WIDTH_BUCKETS - 1))];
          var qn = qbk.n;
          var qc = qbk.coords;
          if (globe) {
            // Endpoint *indices*, not coordinates: an arc needs the positions
            // themselves to interpolate, and the stride stays 4 so one bucket
            // shape serves both geometries.
            qc[qn] = qa; qc[qn + 1] = qb; qc[qn + 2] = 0; qc[qn + 3] = 0;
          } else {
            qc[qn] = qax; qc[qn + 1] = qay; qc[qn + 2] = qbx; qc[qn + 3] = qby;
          }
          qbk.n = qn + 4;
        }

        // Far slabs first, and within a slab thin first — so the strongly
        // related pairs land on top of the merely adjacent ones where they
        // cross, and the near surface lands on top of the far one.
        ctx.strokeStyle = 'rgba(' + style.proximityEdgeColor + ',' + style.proximityEdgeAlpha + ')';
        for (var pslab = 0; pslab < slabs; pslab++) {
          ctx.globalAlpha = globe ? depthAlpha(pslab) : 1;
          for (var pl = 0; pl < WIDTH_BUCKETS; pl++) {
            var plb = proximityBuckets[pslab * WIDTH_BUCKETS + pl];
            if (plb.n === 0) continue;
            ctx.lineWidth = pw0 + (pl / (WIDTH_BUCKETS - 1)) * (pw1 - pw0);
            var plc = plb.coords;
            ctx.beginPath();
            for (var pt = 0; pt < plb.n; pt += 4) {
              if (globe) {
                appendArc(plc[pt], plc[pt + 1], halfW, halfH, camX, camY, zoom);
              } else {
                ctx.moveTo(halfW + (plc[pt] - camX) * zoom, halfH + (plc[pt + 1] - camY) * zoom);
                ctx.lineTo(halfW + (plc[pt + 2] - camX) * zoom, halfH + (plc[pt + 3] - camY) * zoom);
              }
            }
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }

      // --- Cluster edges ('clusters' only, parked — see [D View.6]) --------
      // The same proximity graph, but an edge is drawn only when both
      // endpoints are in the same component and it survived the length cut —
      // which is what makes a component read as a shape rather than as a
      // recolouring. One path per component, each with its own hue; the
      // grouping was done once, when the clusters were computed, so nothing
      // here allocates or rescans.
      if (isClusters && view && view.clusters) {
        var groups = view.clusters.edgeGroups;
        ctx.lineWidth = style.clusterEdgeWidth;
        ctx.globalAlpha = style.clusterEdgeAlpha;
        for (var gi = 0; gi < groups.length; gi++) {
          var pts = groups[gi].items;
          ctx.strokeStyle = clusterColor(groups[gi].label, style.clusterSaturation, style.clusterLightness);
          ctx.beginPath();
          for (var pi = 0; pi < pts.length; pi += 2) {
            var ga = pts[pi], gb = pts[pi + 1];
            if (!segmentInBounds(sx[ga], sy[ga], sx[gb], sy[gb], bounds, margin)) continue;
            ctx.moveTo(halfW + (sx[ga] - camX) * zoom, halfH + (sy[ga] - camY) * zoom);
            ctx.lineTo(halfW + (sx[gb] - camX) * zoom, halfH + (sy[gb] - camY) * zoom);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // --- Input edges ('relations'), bucketed by alpha --------------------
      // One stroke() per edge also means one 'rgba(...)' string per edge per
      // frame. Quantizing alpha into a fixed number of buckets collapses that
      // to a handful of paths and style changes, independent of |E|.
      var b;
      for (b = 0; b < edgeBuckets.length; b++) edgeBuckets[b].n = 0;

      var edgeA = state.edgeA, edgeB = state.edgeB, edgeW = state.edgeW;
      for (var e = 0; isRelations && e < state.edgeCount; e++) {
        var w = edgeW[e];
        // Sign picks the colour family, magnitude the opacity. Weight exactly 0
        // carries no relation, so it is drawn like an absent edge: not at all.
        var magnitude, base;
        if (w > 0) {
          if (w < hitThreshold) continue;
          magnitude = w; base = 0;
        } else if (w < 0) {
          if (w > missThreshold) continue;
          magnitude = -w; base = ALPHA_BUCKETS;
        } else {
          continue;
        }

        var ia = edgeA[e], ib = edgeB[e];
        var ax = sx[ia], ay = sy[ia];
        var bx = sx[ib], by = sy[ib];
        if (!segmentInBounds(ax, ay, bx, by, bounds, margin)) continue;

        var q = Math.floor(magnitude * ALPHA_BUCKETS);
        if (q >= ALPHA_BUCKETS) q = ALPHA_BUCKETS - 1;
        if (q < 0) q = 0;
        var eslab = globe ? depthSlab((projZ[ia] + projZ[ib]) / 2) : 0;
        var bucket = edgeBuckets[eslab * EDGE_STRIDE + base + q];
        var coords = bucket.coords;
        var n = bucket.n;
        if (globe) {
          coords[n] = ia; coords[n + 1] = ib; coords[n + 2] = 0; coords[n + 3] = 0;
        } else {
          coords[n] = ax; coords[n + 1] = ay; coords[n + 2] = bx; coords[n + 3] = by;
        }
        bucket.n = n + 4;
      }

      // Negative relations are painted first so positive ones land on top: the
      // "what is this close to" reading is the one worth privileging, and a
      // negative edge is long by construction — the physics pushes its endpoints
      // apart — so it covers far more pixels than a positive one and would
      // otherwise dominate the view on sheer painted area.
      // On the globe the depth slab is the outermost loop of the three, so the
      // far surface is finished — misses and hits both — before the near one
      // starts. Ordering within a slab is unchanged, and on the plane the slab
      // loop runs exactly once.
      for (var eslab2 = 0; eslab2 < slabs; eslab2++) {
        ctx.globalAlpha = globe ? depthAlpha(eslab2) : 1;
        for (var pass = 0; pass < 2; pass++) {
          var isMiss = pass === 0;
          var bucketBase = isMiss ? ALPHA_BUCKETS : 0;
          var maxAlpha = isMiss ? style.maxMissAlpha : style.maxHitAlpha;
          var color = isMiss ? style.missEdgeColor : style.hitEdgeColor;
          var width = isMiss ? style.missEdgeWidth : style.edgeWidth;

          for (var level = 0; level < ALPHA_BUCKETS; level++) {
            var bkt = edgeBuckets[eslab2 * EDGE_STRIDE + bucketBase + level];
            if (bkt.n === 0) continue;
            // Representative magnitude for the bucket, scaled into [0, maxAlpha].
            var bAlpha = Math.max(
              ((level + 0.5) / ALPHA_BUCKETS) * maxAlpha,
              style.minEdgeAlpha
            );
            ctx.strokeStyle = 'rgba(' + color + ',' + bAlpha + ')';
            ctx.lineWidth = width;
            var bc = bkt.coords;
            ctx.beginPath();
            for (var t = 0; t < bkt.n; t += 4) {
              if (globe) {
                appendArc(bc[t], bc[t + 1], halfW, halfH, camX, camY, zoom);
              } else {
                ctx.moveTo(halfW + (bc[t] - camX) * zoom, halfH + (bc[t + 1] - camY) * zoom);
                ctx.lineTo(halfW + (bc[t + 2] - camX) * zoom, halfH + (bc[t + 3] - camY) * zoom);
              }
            }
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;

      // --- Nodes, one path for all of them ---------------------------------
      // Same idea: every unhighlighted node shares colour and radius, so they
      // can go into a single path and a single fill().
      // In 'clusters' the nodes carry the finding, so they are grouped into
      // one path per component instead — the fills stay O(components), which
      // is orders of magnitude below O(n), and the single-path optimization
      // above is preserved *within* each group. Nodes in no component keep a
      // neutral grey rather than a hue of their own, so what is coloured is
      // exactly what was found.
      if (isClusters && view && view.clusters) {
        var nodeGroups = view.clusters.nodeGroups;
        for (var ni = 0; ni < nodeGroups.length; ni++) {
          var label = nodeGroups[ni].label;
          var members = nodeGroups[ni].items;
          ctx.fillStyle = label < 0
            ? 'rgb(' + style.clusterOutlierColor + ')'
            : clusterColor(label, style.clusterSaturation, style.clusterLightness);
          ctx.beginPath();
          for (var mi = 0; mi < members.length; mi++) {
            var m = members[mi];
            if (m === highlighted || m === pinned) continue;
            var gx = sx[m], gy = sy[m];
            if (gx < bounds.minX - margin || gx > bounds.maxX + margin ||
                gy < bounds.minY - margin || gy > bounds.maxY + margin) continue;
            var mx = halfW + (gx - camX) * zoom;
            var my = halfH + (gy - camY) * zoom;
            ctx.moveTo(mx + nodeRadius, my);
            ctx.arc(mx, my, nodeRadius, 0, Math.PI * 2);
          }
          ctx.fill();
        }
      } else if (globe) {
        // One path per depth slab rather than one for all nodes: the single-
        // path optimization is preserved *within* a slab, the fills stay
        // O(DEPTH_BUCKETS) — a constant, not a function of n — and painting
        // them far-to-near is what makes a node on the near surface cover one
        // behind it instead of the draw order deciding at random.
        for (var nb = 0; nb < DEPTH_BUCKETS; nb++) nodeBuckets[nb].n = 0;
        for (var gi = 0; gi < state.count; gi++) {
          var gxp = sx[gi], gyp = sy[gi];
          if (gxp < bounds.minX - margin || gxp > bounds.maxX + margin ||
              gyp < bounds.minY - margin || gyp > bounds.maxY + margin) continue;
          if (gi === highlighted || gi === pinned) continue;
          var gbk = nodeBuckets[depthSlab(projZ[gi])];
          var gn = gbk.n;
          gbk.coords[gn] = halfW + (gxp - camX) * zoom;
          gbk.coords[gn + 1] = halfH + (gyp - camY) * zoom;
          gbk.n = gn + 2;
        }
        ctx.fillStyle = style.nodeColor;
        ctx.strokeStyle = style.nodeBorderColor;
        ctx.lineWidth = nodeBorderWidth;
        for (var nslab = 0; nslab < DEPTH_BUCKETS; nslab++) {
          var nbk = nodeBuckets[nslab];
          if (nbk.n === 0) continue;
          ctx.globalAlpha = depthAlpha(nslab);
          ctx.beginPath();
          for (var np = 0; np < nbk.n; np += 2) {
            var nx = nbk.coords[np], ny = nbk.coords[np + 1];
            ctx.moveTo(nx + nodeRadius, ny);
            ctx.arc(nx, ny, nodeRadius, 0, Math.PI * 2);
          }
          ctx.fill();
          if (nodeBorderWidth > 0) ctx.stroke();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = style.nodeColor;
        ctx.beginPath();
        for (var i = 0; i < state.count; i++) {
          var x = sx[i], y = sy[i];
          if (x < bounds.minX - margin || x > bounds.maxX + margin ||
              y < bounds.minY - margin || y > bounds.maxY + margin) continue;
          if (i === highlighted || i === pinned) continue;
          var px = halfW + (x - camX) * zoom;
          var py = halfH + (y - camY) * zoom;
          // moveTo starts a fresh subpath, otherwise arcs get joined by a line.
          ctx.moveTo(px + nodeRadius, py);
          ctx.arc(px, py, nodeRadius, 0, Math.PI * 2);
        }
        ctx.fill();
        if (nodeBorderWidth > 0) {
          ctx.lineWidth = nodeBorderWidth;
          ctx.strokeStyle = style.nodeBorderColor;
          ctx.stroke();
        }
      }

      // The marked nodes, lifted out of the batch above and drawn last so
      // nothing paints over them. At most two, in one path and one fill:
      // hovered and pinned wear the same mark, the pinned one being told apart
      // by the card anchored to it rather than by a second visual language.
      // The dedupe matters — a node that is both would otherwise be stroked
      // twice, and a semi-transparent highlightColor would show the seam.
      if (highlighted >= 0 || pinned >= 0) {
        // Scaled by whatever factor the node radius just took, so the
        // highlight keeps the ratio to a plain node that the defaults
        // establish. Held fixed it stopped reading as a highlight at high
        // zoom: nodeRadiusMax and highlightRadius are both 5, so a zoomed-in
        // node reached exactly the size of the thing marking it and only the
        // fill colour was left to tell them apart.
        var highlightRadius = style.nodeRadius > 0
          ? style.highlightRadius * (nodeRadius / style.nodeRadius)
          : style.highlightRadius;
        var markedCount = 0;
        ctx.fillStyle = style.highlightColor;
        ctx.beginPath();
        for (var mk = 0; mk < 2; mk++) {
          var mn = mk === 0 ? pinned : highlighted;
          if (mn < 0 || mn >= state.count) continue;
          if (mk === 1 && mn === pinned) continue;
          var hx = halfW + (sx[mn] - camX) * zoom;
          var hy = halfH + (sy[mn] - camY) * zoom;
          // moveTo before the arc, or the second one is joined to the first
          // by a straight line across the graph.
          ctx.moveTo(hx + highlightRadius, hy);
          ctx.arc(hx, hy, highlightRadius, 0, Math.PI * 2);
          markedCount++;
        }
        if (markedCount > 0) {
          ctx.fill();
          if (style.highlightBorderWidth > 0) {
            ctx.lineWidth = style.highlightBorderWidth;
            ctx.strokeStyle = style.highlightBorderColor;
            ctx.stroke();
          }
        }
      }
    }

    // Recomputes the fit-to-view reference zoom for a new world radius while
    // keeping the user where they were — same treatment as resize(), which
    // faces the same problem from the other direction (viewport changed, world
    // did not). Every zoom limit is a multiple of baseZoom, so it has to be
    // rebased whenever the world's extent changes even if the view does not.
    function rebase(worldRadius) {
      var previousBase = baseZoom;
      baseZoom = computeBaseZoom(worldRadius);
      if (previousBase > 0) camera.zoom *= baseZoom / previousBase;
      clampPan();
    }

    // Rebase *and* return the user to the fitted view. Reserved for the one
    // moment where there is no previous view to keep: the first draw, before
    // anyone has looked anywhere. Every later (re)build goes through rebase()
    // — the reference zoom follows the world's extent, the camera does not
    // ([D Interact.2]).
    function fitView(worldRadius) {
      baseZoom = computeBaseZoom(worldRadius);
      camera.zoom = baseZoom;
      camera.x = 0;
      camera.y = 0;
    }

    function clampZoom(zoom) {
      return Math.min(baseZoom * 250, Math.max(baseZoom * 0.25, zoom));
    }

    // Pan is bounded to the graph's own extent plus a margin: the world point
    // under the centre of the viewport may travel a little past the outermost
    // node, but no further. So the graph can be pushed to the edge of the view
    // and slightly beyond, but never off it — there is no way to end up
    // panning through empty space with nothing on screen and no idea which way
    // back.
    //
    // The graph's own extent is exact and fixed (the layout is a normalized
    // unit disk on the origin, [D Phys.2]); the margin is what makes the bound
    // comfortable rather than abrupt, and is taken per axis against the
    // *current* visible half-extent. Two things follow, both wanted. It stays
    // the same proportion of the screen at every zoom level, instead of being
    // a fixed world distance that is imperceptible zoomed out and dozens of
    // screenfuls of nothing zoomed in. And a wide viewport gets a
    // proportionally wider horizontal range for free — on 16:9 roughly 1.8x
    // the vertical margin — which is where the extra room is actually wanted,
    // with no aspect ratio special-cased anywhere.
    function clampPan() {
      var radius = world.perimeterRadius;
      if (!(radius > 0) || !(camera.zoom > 0)) return;
      var limitX = radius + PAN_SLACK * (canvas.width / 2) / camera.zoom;
      var limitY = radius + PAN_SLACK * (canvas.height / 2) / camera.zoom;
      camera.x = Math.min(limitX, Math.max(-limitX, camera.x));
      camera.y = Math.min(limitY, Math.max(-limitY, camera.y));
    }

    return {
      draw: draw,
      resize: resize,
      fitView: fitView,
      rebase: rebase,
      clampZoom: clampZoom,
      clampPan: clampPan,
      camera: camera,
      // worldToScreen stays internal: draw() and nodeScreenPos() are its only
      // callers, and the hot loops there inline the transform anyway to avoid
      // its per-point array. screenToWorld is exported because interaction
      // genuinely needs it — hit-testing and zoom-to-cursor both start from a
      // cursor position — and nodeScreenPos for the one thing that runs the
      // other way, a pinned panel following its node.
      screenToWorld: screenToWorld,
      nodeScreenPos: nodeScreenPos,
      effectiveNodeRadius: effectiveNodeRadius,
      setHighlighted: function (nid) { highlighted = nid; },
      setPinned: function (nid) { pinned = nid; },
      // The globe's three additions to the renderer's public surface. The
      // rotation is exposed for the same reason pan and zoom are: it is how
      // someone is *looking* at the graph, so interaction owns it and the
      // layout never touches it ([D Interact.2]).
      isGlobe: isGlobe,
      rotateBy: rotateBy,
      pickGlobe: pickGlobe
    };
  }

  // ---------------------------------------------------------------------
  // Interaction — pan, zoom (wheel and pinch), hover hit-testing via the
  // shared spatial grid. No node dragging by design ([FR Scope .W]).
  //
  // Pointer Events rather than mouse events, for one reason: `touch-action:
  // none` below is what lets this own the gesture, and it takes the browser's
  // native pan/zoom away on a touch device whether or not anything replaces
  // it. With mouse handlers alone the canvas was inert to touch — no native
  // pinch, because it had been suppressed, and no synthetic one. One pointer
  // pans, two pinch; a mouse is simply a pointer that never has a second.
  // ---------------------------------------------------------------------

  function attachInteraction(canvas, renderer, grid, grid3, world, hooks) {
    // Live pointers by pointerId. Its size is the whole gesture state machine:
    // 0 = hovering, 1 = panning, 2+ = pinching.
    var pointers = new Map();
    var lastPanX = 0, lastPanY = 0;
    // Distance between the two pinching pointers on the previous move, so the
    // zoom factor is a ratio against the frame before rather than against the
    // gesture's start — the same incremental form the wheel already uses.
    var pinchSpan = 0;
    var hitScratch = [];

    // A click is a press and release that went nowhere, which is the only
    // definition available here: every press already means something (a pan,
    // a rotation, half a pinch), so the click has to be recognised by what
    // the gesture turned out *not* to be. The candidate survives from the
    // first pointer down until the last pointer up, and is withdrawn by a
    // second pointer, by a cancel, or by movement past the slop below — a
    // drag that pans by three pixels is still a drag, but a hand releasing a
    // mouse button is never perfectly still, so a threshold of zero would
    // make clicking a node a matter of luck. Measured from the press, not
    // accumulated along the path, so a slow drag out and back reads as the
    // drag it was.
    var CLICK_SLOP = 5;
    var clickCandidate = false;
    var clickId = -1;
    var clickX = 0, clickY = 0;

    canvas.style.cursor = 'grab';
    canvas.style.touchAction = 'none';

    // Hit-testing on the sphere. The cursor is unprojected onto the *near*
    // surface ([D Globe.7]) and the query runs in the 3-D index at that point,
    // so the candidate set is genuinely local — the alternative, scanning
    // every node's projected position, is the O(n) hover the flat grid exists
    // to avoid, and it would also let a faded node on the far side win a
    // contest against the solid one drawn over it.
    function findNodeOnGlobe(screenX, screenY) {
      var pick = renderer.pickGlobe(screenX, screenY);
      if (!pick) return -1;
      var g = world.state.globe;
      var hitRadius = Math.min(
        Math.max(renderer.effectiveNodeRadius() * 2, 6) / renderer.camera.zoom,
        grid3.cellSize
      );
      grid3.queryInto(pick[0], pick[1], pick[2], hitScratch);
      var best = -1;
      var bestDist = hitRadius;
      for (var i = 0; i < hitScratch.length; i++) {
        var idx = hitScratch[i];
        var dx = g.x[idx] - pick[0];
        var dy = g.y[idx] - pick[1];
        var dz = g.z[idx] - pick[2];
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < bestDist) { bestDist = dist; best = idx; }
      }
      return best;
    }

    function findNodeAt(screenX, screenY) {
      if (renderer.isGlobe()) return findNodeOnGlobe(screenX, screenY);
      var state = world.state;
      var worldPos = renderer.screenToWorld(screenX, screenY);
      // Aimed at the radius actually painted ([D Render.3]), not at the base
      // one, so the target tracks the node's on-screen size at every zoom.
      // The 3x3 cell query only guarantees coverage up to one cell around the
      // cursor, so a larger hit radius would silently miss candidates.
      var hitRadius = Math.min(
        Math.max(renderer.effectiveNodeRadius() * 2, 6) / renderer.camera.zoom,
        grid.cellSize
      );
      grid.queryInto(worldPos[0], worldPos[1], hitScratch);
      var best = -1;
      var bestDist = hitRadius;
      for (var i = 0; i < hitScratch.length; i++) {
        var idx = hitScratch[i];
        var dx = state.x[idx] - worldPos[0];
        var dy = state.y[idx] - worldPos[1];
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) { bestDist = dist; best = idx; }
      }
      return best;
    }

    // Zoom about a fixed screen point, keeping the world point under it put.
    // Shared by the wheel and the pinch, which differ only in where the anchor
    // and the factor come from.
    function zoomAt(screenX, screenY, factor) {
      var before = renderer.screenToWorld(screenX, screenY);
      renderer.camera.zoom = renderer.clampZoom(renderer.camera.zoom * factor);
      var after = renderer.screenToWorld(screenX, screenY);
      renderer.camera.x += before[0] - after[0];
      renderer.camera.y += before[1] - after[1];
      // Zoom-to-cursor moves the camera too, so it is bounded by the same
      // rule as a drag — otherwise zooming out at the edge of the graph
      // walks the camera outwards a little on every notch.
      renderer.clampPan();
    }

    function panBy(dxScreen, dyScreen) {
      renderer.camera.x -= dxScreen / renderer.camera.zoom;
      renderer.camera.y -= dyScreen / renderer.camera.zoom;
      // Clamped here rather than by ignoring the drag past the limit: the
      // camera keeps tracking the cursor along whichever axis is still
      // free, so dragging into a corner slides along the bound instead of
      // freezing both axes the moment one of them runs out.
      renderer.clampPan();
    }

    // Midpoint and separation of the first two live pointers, in client
    // coordinates. Iteration order over a Map is insertion order, so "the
    // first two" is "the two that have been down longest" — stable for as
    // long as the gesture lasts, which is what keeps a third stray finger
    // from swapping the pair mid-pinch.
    function pinchGeometry() {
      var it = pointers.values();
      var a = it.next().value;
      var b = it.next().value;
      var dx = b.x - a.x, dy = b.y - a.y;
      return {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        span: Math.sqrt(dx * dx + dy * dy)
      };
    }

    // What a one-pointer drag does right now ([D Globe.7]). On the plane it
    // has always panned and still does. On the globe the primary drag turns
    // the world — that is the gesture the geometry asks for, and panning a
    // sphere that fills its own silhouette is the lesser of the two — while
    // the middle button and Shift both still pan, so the flat gesture is never
    // actually taken away.
    function dragMode(e) {
      if (!renderer.isGlobe()) return 'pan';
      if (e.pointerType === 'mouse' && (e.button === 1 || e.buttons === 4)) return 'pan';
      if (e.shiftKey) return 'pan';
      return 'rotate';
    }
    var activeDrag = 'pan';

    function onPointerDown(e) {
      // Secondary mouse buttons are not a pan: right-click used to start one
      // and leave the cursor stuck in 'grabbing' behind the context menu. The
      // middle button is now an exception, being the globe's pan gesture.
      var middle = e.pointerType === 'mouse' && e.button === 1;
      if (e.pointerType === 'mouse' && e.button !== 0 && !(middle && renderer.isGlobe())) return;
      // Otherwise a middle-drag scrolls the page under the gesture.
      if (middle) e.preventDefault();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* already gone */ }

      if (pointers.size === 1) {
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        activeDrag = dragMode(e);
        canvas.style.cursor = 'grabbing';
        // The middle button pans the globe and nothing else: a click is the
        // primary button, or a finger, and never the one whose gesture is
        // already "move the view without hovering anything".
        clickCandidate = !middle;
        clickId = e.pointerId;
        clickX = e.clientX;
        clickY = e.clientY;
      } else if (pointers.size === 2) {
        // A second finger ends the pan and any hover it had opened: what
        // follows is a pinch, and the panel would otherwise sit under it.
        // Re-anchor to the midpoint at the same time as the span: the pan
        // reference is still the first finger's own position, and leaving it
        // there would make the pinch's first move read as a jump of half the
        // distance between the two.
        var geo = pinchGeometry();
        lastPanX = geo.x;
        lastPanY = geo.y;
        pinchSpan = geo.span;
        clickCandidate = false;
        hooks.onHoverEnd();
      }
    }

    function onPointerMove(e) {
      var rect = canvas.getBoundingClientRect();

      if (pointers.has(e.pointerId)) {
        var tracked = pointers.get(e.pointerId);
        tracked.x = e.clientX;
        tracked.y = e.clientY;
      }

      if (clickCandidate && e.pointerId === clickId) {
        var mdx = e.clientX - clickX, mdy = e.clientY - clickY;
        if (mdx * mdx + mdy * mdy > CLICK_SLOP * CLICK_SLOP) clickCandidate = false;
      }

      if (pointers.size >= 2) {
        var geo = pinchGeometry();
        // Pinch pans by its midpoint as well as zooming by its span — the two
        // are one gesture to the hand doing it, and a pinch that only scaled
        // would fight any attempt to reposition while zooming.
        panBy(geo.x - lastPanX, geo.y - lastPanY);
        lastPanX = geo.x;
        lastPanY = geo.y;
        if (pinchSpan > 0 && geo.span > 0) {
          zoomAt(geo.x - rect.left, geo.y - rect.top, geo.span / pinchSpan);
        }
        pinchSpan = geo.span;
        hooks.onViewChange();
        return;
      }

      if (pointers.size === 1) {
        if (activeDrag === 'rotate') {
          renderer.rotateBy(e.clientX - lastPanX, e.clientY - lastPanY);
        } else {
          panBy(e.clientX - lastPanX, e.clientY - lastPanY);
        }
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        hooks.onHoverEnd();
        hooks.onViewChange();
        return;
      }

      // Hovering. Only a mouse hovers: a finger that is not down is not
      // pointing at anything, and a touch drag would otherwise open the detail
      // panel under the finger doing the panning.
      if (e.pointerType !== 'mouse') return;
      var nid = findNodeAt(e.clientX - rect.left, e.clientY - rect.top);
      if (nid >= 0) {
        canvas.style.cursor = 'pointer';
        hooks.onHover(nid, e.clientX, e.clientY);
      } else {
        canvas.style.cursor = 'grab';
        hooks.onHoverEnd();
      }
    }

    function onPointerUp(e) {
      if (!pointers.delete(e.pointerId)) return;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already gone */ }

      // Resolved before the pan/pinch bookkeeping below, and only once the
      // glass is clear: a release that still leaves a finger down is the end
      // of a pinch, not a click. Hit-tested here rather than at press time,
      // because on a running layout the node under the cursor at the release
      // is the one the eye was on — and because a press that turned out to be
      // a drag must cost nothing.
      if (clickCandidate && e.pointerId === clickId && pointers.size === 0) {
        var clickRect = canvas.getBoundingClientRect();
        hooks.onClick(
          findNodeAt(e.clientX - clickRect.left, e.clientY - clickRect.top),
          e.clientX, e.clientY
        );
      }
      if (e.pointerId === clickId) clickCandidate = false;

      if (pointers.size === 1) {
        // Down from a pinch to a pan: re-anchor to the finger still on the
        // glass, or the next move would be read as a jump from the midpoint
        // the pinch was tracking.
        var remaining = pointers.values().next().value;
        lastPanX = remaining.x;
        lastPanY = remaining.y;
        pinchSpan = 0;
      } else if (pointers.size === 0) {
        pinchSpan = 0;
        canvas.style.cursor = 'grab';
      }
    }

    // A cancelled pointer is the system taking the gesture away — never a
    // click, whatever the pointer had done up to that moment. It still has to
    // go through the release path, or the pointer stays in the map forever
    // and the widget thinks a finger is down.
    function onPointerCancel(e) {
      if (e.pointerId === clickId) clickCandidate = false;
      onPointerUp(e);
    }

    function onPointerLeave(e) {
      if (pointers.size === 0 && e.pointerType === 'mouse') hooks.onHoverEnd();
    }

    function onWheel(e) {
      e.preventDefault();
      var rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.pow(1.0015, -e.deltaY));
      hooks.onViewChange();
    }

    // Pointer capture routes every move and release back here even when the
    // gesture leaves the canvas, so — unlike the window-level mouseup this
    // replaces — nothing is registered outside the element. That listener was
    // never removed on destroy(), and its closure held the canvas, the
    // renderer and the world: every destroyed instance stayed reachable,
    // typed arrays and all.
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return {
      destroy: function () {
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerCancel);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('wheel', onWheel);
        pointers.clear();
      }
    };
  }

  // ---------------------------------------------------------------------
  // Detail Panel — a title Nodino owns (the node's uid) above a body slot the
  // host owns, filled through onNodeHover / onNodePin ([F API.3]). Never
  // receives `nid` ([F Data.2]).
  //
  // An instance owns one node's card, and there are two of them per widget:
  // the one that follows the cursor and the one a click pins ([F Interact.3]).
  // They are the same component because they show the same thing the same way
  // — the difference is entirely which node they are about, how they are
  // placed, whether they take the mouse, and which handler fills them, and
  // none of that is the panel's business: the handler arrives as an argument
  // to show(). `pinned` is therefore fixed at construction: an instance never
  // changes sides, so nothing here has a mode to be in.
  // ---------------------------------------------------------------------

  function createDetailPanel(container, pinned) {
    var el = document.createElement('div');
    // Static chrome lives in nodino.css (.nodino-detail-panel, plus
    // .nodino-pinned for the pinned instance — `pointer-events: auto` and a
    // heavier card); only the per-call position/visibility below is set here.
    el.className = 'nodino-detail-panel' + (pinned ? ' nodino-pinned' : '');

    // Two slots rather than one innerHTML. The uid is the one thing Nodino
    // always knows about a node, so it is always the title and is never at
    // the mercy of what the host does; everything else is the host's, and
    // goes below. The host is handed `body`, not `el`, so nothing it injects
    // can disturb the panel's own positioning or clear the title.
    var titleEl = document.createElement('div');
    titleEl.className = 'nodino-detail-title';
    var bodyEl = document.createElement('div');
    bodyEl.className = 'nodino-detail-body';
    el.appendChild(titleEl);
    el.appendChild(bodyEl);
    container.appendChild(el);

    var token = 0;
    // Gap between the anchor (the cursor while hovering, the node itself once
    // pinned) and the panel's near corner, on both axes.
    var CURSOR_GAP = 12;
    // Last cursor position, so the panel can be re-placed against its own new
    // size when async content lands without the caller handing it back.
    var lastX = 0, lastY = 0;

    function moveTo(screenX, screenY) {
      lastX = screenX;
      lastY = screenY;
      var containerRect = container.getBoundingClientRect();
      var x = screenX - containerRect.left + CURSOR_GAP;
      var y = screenY - containerRect.top + CURSOR_GAP;
      // The container clips (`overflow: hidden`, set in create()), so a panel
      // placed past its right or bottom edge is silently truncated — which is
      // exactly what happened to every node near those edges. Flip to the
      // other side of the cursor when the panel would not fit, and clamp to 0
      // as a last resort for one larger than the container itself. Read
      // before the writes below so the two do not interleave into a second
      // layout pass.
      var width = el.offsetWidth, height = el.offsetHeight;
      if (x + width > containerRect.width) {
        x = Math.max(0, screenX - containerRect.left - CURSOR_GAP - width);
      }
      if (y + height > containerRect.height) {
        y = Math.max(0, screenY - containerRect.top - CURSOR_GAP - height);
      }
      el.style.left = x + 'px';
      el.style.top = y + 'px';
    }

    function show(node, screenX, screenY, resolveContent) {
      var myToken = ++token;
      el.style.display = 'block';

      // textContent, not innerHTML: a uid is host data, never markup.
      titleEl.textContent = node.uid;
      bodyEl.textContent = '';

      // Every route below ends in exactly one moveTo, and each is placed once
      // its own content is in the slot: moveTo() measures the panel to decide
      // whether it has to flip away from a container edge, so placing it
      // first would measure the previous node's body.

      // No handler is not an error state — the title alone is the default
      // content, and a host that wants nothing more supplies nothing.
      if (typeof resolveContent !== 'function') {
        moveTo(screenX, screenY);
        return;
      }

      // Two routes into the same slot, and the host may take either: write
      // into `bodyEl` directly (any DOM it likes, listeners included — the
      // node stays put until the hover ends), or return content and let the
      // panel write it. A returned value lands last and therefore wins.
      //
      // Nothing here renders a loading or error state of its own. While a
      // returned promise is in flight the slot simply holds whatever the
      // handler left in it — which is exactly the point of handing over the
      // element: a spinner, a skeleton or nothing at all is a decision about
      // the host's own data, and any placeholder Nodino invented would have
      // to be overridden by every host that wanted a different one.
      var result = resolveContent(node, bodyEl);
      if (result && typeof result.then === 'function') {
        // Against whatever the handler injected synchronously — its own
        // loading state, typically ([D API.5]) — and again when the promise
        // lands, since the content that replaces it is rarely the same size.
        // The stored cursor position is what lets the second placement happen
        // without the caller handing it back.
        moveTo(screenX, screenY);
        result.then(function (content) {
          if (myToken !== token) return;
          if (content == null) return;
          bodyEl.innerHTML = content;
          moveTo(lastX, lastY);
        }).catch(function (err) {
          // The slot is left as the handler left it — rendering the failure
          // is the handler's call too. Warned rather than swallowed, since a
          // rejection here is a bug in host code Nodino called. Named by the
          // card it happened in, the two handlers being separate host code
          // that can fail separately ([D API.11]).
          if (myToken === token) {
            console.warn('[Nodino] ' + (pinned ? 'onNodePin' : 'onNodeHover') + ' rejected', err);
          }
        });
      } else {
        if (result != null) bodyEl.innerHTML = result;
        moveTo(screenX, screenY);
      }
    }

    function hide() {
      token++;
      el.style.display = 'none';
    }

    function destroy() { container.removeChild(el); }

    return { show: show, moveTo: moveTo, hide: hide, destroy: destroy };
  }

  // ---------------------------------------------------------------------
  // Lifecycle state machine ([F State.1]) — the transition table, at module
  // scope because both the instance (which enforces it) and the built-in
  // simulation controls (which render it) are driven by it. Per action:
  // current state -> next state; a state absent from an action's map has no
  // legal transition for it, and the call is refused.
  //
  // Two verbs are deliberately not here, because their target is not a
  // function of the current state alone:
  //   load()    - legal in every state except 'destroyed'; lands on 'empty',
  //               'loaded' or 'settled' depending on the data — see
  //               stateAfterRebuild().
  //   destroy() - legal in every state except 'destroyed'; always terminal.
  // ---------------------------------------------------------------------

  var TRANSITIONS = {
    start: { loaded: 'running', running_paused: 'running' },
    pause: { running: 'running_paused', forced: 'forced_paused' },
    // Resuming from 'forced_paused' goes through forceContinue(), not start()
    // — the two land in the same place and do the same thing, but the button
    // you press says which regime you are resuming into. From a paused forced
    // run the only way onward is another forced run (the cap stays waived,
    // forcedStopVelocity stays the criterion), so Run is greyed out there and
    // Force carries the resume.
    forceContinue: { settled: 'forced', forced_paused: 'forced' },
    // Refused in 'empty' (nothing to replay) and 'loaded' (already sitting at
    // frame one — a self-loop with no observable effect).
    restart: {
      running: 'loaded', running_paused: 'loaded', settled: 'loaded',
      forced: 'loaded', forced_paused: 'loaded', forced_settled: 'loaded'
    }
  };

  function isTransitionLegal(action, state) {
    return !!TRANSITIONS[action][state];
  }

  // ---------------------------------------------------------------------
  // View Mode Toggle — small always-on control, unlike the debug panel: it
  // switches what the graph *means* to the reader, not how it is tuned.
  // Suppressed with config.showViewModeToggle = false.
  // ---------------------------------------------------------------------

  // [value, label, needsStoppedLayout]. The first reads the input and is
  // always available; the other two read the layout the run produced, so they
  // are only live while it is standing still ([D View.2]).
  var VIEW_MODES = [
    ['relations', 'Relations', false],
    ['proximity', 'Proximity', true]
    // Parked, not deleted ([D View.6]): on real layouts the clustering did
    // not add enough over the proximity graph to earn a third button, and its
    // one knob has a visible failure mode ([Rsk View.1]). Everything behind
    // it still works — computeClusters(), the renderer branch, the config
    // fields — so reviving it is uncommenting this line. A host that wants
    // it now can still reach it with updateConfig({ viewMode: 'clusters' }).
    // ['clusters', 'Clusters', true]
  ];

  function createViewModeToggle(container, config, onChange, stopped) {
    // Static chrome lives in nodino.css (.nodino-view-toggle); only the
    // active/inactive state and each button's disabled flag are set here.
    var el = document.createElement('div');
    el.className = 'nodino-view-toggle';
    container.appendChild(el);

    var buttons = VIEW_MODES.map(function (entry) {
      var button = document.createElement('button');
      button.textContent = entry[1];
      button.addEventListener('click', function () {
        onChange({ viewMode: entry[0] });
      });
      el.appendChild(button);
      return { mode: entry[0], el: button, needsStopped: entry[2] };
    });

    // Relations is always live. Proximity and Clusters read the layout, so
    // they are offered exactly while the simulation is *stopped* ([D View.2])
    // — not merely while converged: the objection was that the layout
    // underneath was still moving, and a suspended run is as still as a
    // finished one.
    //
    // Disabled, not removed. The readings are a set worth seeing whole — you
    // can tell that Proximity exists before you are allowed to press it — and
    // the pill keeps a constant width instead of resizing and re-centering
    // itself under the cursor as a run starts and stops. Same treatment as
    // the simulation bar ([F State.2]), and for the same reason. The argument
    // is why the parked Clusters entry is left in place above rather than
    // deleted: reviving it should put a third button in a row already built
    // to hold one ([D View.6]).
    function sync(nowStopped) {
      for (var i = 0; i < buttons.length; i++) {
        var entry = buttons[i];
        entry.el.disabled = entry.needsStopped && !nowStopped;
        entry.el.classList.toggle('active', config.viewMode === entry.mode);
      }
    }
    sync(!!stopped);

    return { sync: sync, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Geometry Toggle — plane vs globe ([D Globe.1]). Sits immediately left of
  // the view-mode toggle, and the pairing is the point: that one picks which
  // reading of the graph you get, this one picks which embedding it is drawn
  // in, and the two are independent — every reading exists in both geometries.
  //
  // Icon plus a short label (2D / 3D), so the pair reads at a glance without
  // relying on the icons alone being self-explanatory. Icons drawn inline: two
  // paths each, in currentColor, so they inherit the active and disabled
  // states from the same CSS the view toggle uses and nothing has to be
  // loaded.
  // ---------------------------------------------------------------------

  var GEOMETRY_ICONS = {
    // A flat sheet seen edge-on in perspective — the disk, at an angle.
    plane: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.3" stroke-linejoin="round">' +
      '<path d="M8 3.2 14 8l-6 4.8L2 8z"/></svg>',
    // A sphere with one meridian and one parallel: the least that reads as a
    // globe rather than as a circle.
    globe: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" ' +
      'stroke="currentColor" stroke-width="1.3">' +
      '<circle cx="8" cy="8" r="5.6"/><ellipse cx="8" cy="8" rx="2.4" ry="5.6"/>' +
      '<path d="M2.6 6.2h10.8M2.6 9.8h10.8"/></svg>'
  };

  var GEOMETRIES = [
    ['plane', 'plane', '2-D: the layout in a flat disk', '2D'],
    ['globe', 'globe', '3-D: the layout on the surface of a sphere — drag to turn it, middle-drag or Shift-drag to pan', '3D']
  ];

  function createGeometryToggle(container, config, onChange) {
    var el = document.createElement('div');
    el.className = 'nodino-geometry-toggle';
    container.appendChild(el);

    var buttons = GEOMETRIES.map(function (entry) {
      var button = document.createElement('button');
      button.innerHTML = GEOMETRY_ICONS[entry[1]] +
        '<span class="nodino-geometry-toggle-label">' + entry[3] + '</span>';
      button.title = entry[2];
      button.setAttribute('aria-label', entry[2]);
      button.addEventListener('click', function () {
        onChange({ geometry: entry[0] });
      });
      el.appendChild(button);
      return { geometry: entry[0], el: button };
    });

    // No disabled state, unlike the view toggle: both geometries are stepped
    // whenever anything is ([D Globe.6]), so neither is ever the reading of a
    // layout that has not been computed. Switching is always legal, running or
    // not.
    function sync() {
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].el.classList.toggle('active', config.geometry === buttons[i].geometry);
      }
    }
    sync();

    return { sync: sync, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Search — a uid filter with an autocomplete list, third pill of the
  // top-centre row ([F Search.1]). Part of the widget rather than the host's
  // own UI for the same reason the simulation bar is ([F State.2]): the uid
  // set is the library's, and a host reimplementing this would be
  // reimplementing a list Nodino already holds, sorted, in memory.
  //
  // A row behaves as the node it names ([D Search.2]): the cursor arriving on
  // it hovers that node, leaving the list ends the hover, and a click pins it
  // — the same three gestures the canvas already answers, reaching the same
  // two cards through the same two handlers ([D API.11]). The keyboard is the
  // same pair one step apart: the arrows hover, Enter pins.
  //
  // Which is why this takes four hooks and owns none of the behaviour behind
  // them. It knows which uid a row names and nothing else about the graph.
  // ---------------------------------------------------------------------

  // How many rows the list offers. A cap rather than a scroller: past a
  // dozen the list has stopped answering the question and the query is what
  // needs narrowing.
  var SEARCH_MAX_RESULTS = 12;

  function createSearchBar(container, hooks) {
    var el = document.createElement('div');
    el.className = 'nodino-search';

    var input = document.createElement('input');
    input.type = 'text';
    // No `search` type: its UA-supplied clear button is styled by the browser
    // and lands outside nodino.css, which is where every other pixel of this
    // chrome is editable from ([D Config.2]).
    input.className = 'nodino-search-input';
    input.placeholder = 'Search…';
    input.setAttribute('aria-label', 'Search nodes by uid');
    // Nothing here wants a browser's own dropdown of past values on top of
    // the one below.
    input.setAttribute('autocomplete', 'off');
    input.spellcheck = false;
    el.appendChild(input);

    var list = document.createElement('div');
    list.className = 'nodino-search-list';
    el.appendChild(list);
    container.appendChild(el);

    // The uids currently offered, and which row the cursor or the keyboard is
    // on. -1 is "the query has matches but no row is being read yet" — typing
    // narrows the list without touching the graph, a keystroke being neither
    // a look nor a choice.
    var matches = [];
    var active = -1;

    // Drops the mark and the hover along with hiding the list. The rows
    // survive being hidden — a blur closes the list and a focus re-offers the
    // same one ([F Search.1]) — so a mark left behind would still be there
    // when it reopens, and the first arrow key would light a second. The
    // hover has to go for the same reason it goes when the cursor leaves the
    // canvas: there is no longer a row being read, so there is nothing the
    // card on screen is about.
    function close() {
      clearMark();
      list.classList.remove('nodino-open');
      active = -1;
      hooks.onHoverEnd();
    }

    function clearMark() {
      var rows = list.children;
      if (active >= 0 && active < rows.length) rows[active].classList.remove('nodino-active');
    }

    // Prefix matches first, then the rest, both in the uid set's own order
    // (lexicographic, [F Data.2]) — so the list is a function of the query
    // alone and shows the same rows in the same order on every machine.
    // Two buckets rather than a scored sort because there is exactly one
    // distinction worth drawing here: "starts with what you typed" is what
    // someone typing a name is looking for, and everything else is a
    // consolation match.
    //
    // Both buckets are capped, not just the one the scan can finish early
    // on: the tail is only ever appended after the head and sliced to the
    // same cap, so collecting more of it than the cap can hold is a few
    // thousand strings gathered per keystroke to be thrown away. Only the head
    // can end the scan early, though: a prefix match further down still
    // outranks every tail match already collected.
    function matchesFor(query) {
      var needle = query.toLowerCase();
      var uids = hooks.getUids();
      var prefix = [];
      var inner = [];
      for (var i = 0; i < uids.length; i++) {
        var at = uids[i].toLowerCase().indexOf(needle);
        if (at === 0) prefix.push(uids[i]);
        else if (at > 0 && inner.length < SEARCH_MAX_RESULTS) inner.push(uids[i]);
        if (prefix.length >= SEARCH_MAX_RESULTS) break;
      }
      return prefix.concat(inner).slice(0, SEARCH_MAX_RESULTS);
    }

    // Marks row `i` and hovers its node — the row being read. The single
    // place that happens, reached identically by the cursor and by the arrow
    // keys, so the two cannot drift apart.
    function read(i) {
      if (i < 0 || i >= matches.length) return;
      clearMark();
      var rows = list.children;
      active = i;
      rows[i].classList.add('nodino-active');
      hooks.onHover(matches[i]);
    }

    // Pins row `i`'s node, writes the uid into the box and closes the list.
    // The click and its keyboard equivalent, and the only route that leaves
    // something behind once the list is gone.
    function choose(i) {
      if (i < 0 || i >= matches.length) return;
      hooks.onPick(matches[i]);
      input.value = matches[i];
      close();
    }

    function bindRow(row, i) {
      // mouseenter, not mouseover: the row has no children, but the event
      // that means "the cursor arrived here" is the one that says so once.
      row.addEventListener('mouseenter', function () { read(i); });
      row.addEventListener('click', function () { choose(i); });
    }

    function render() {
      // The rows about to be replaced include the one being read, so whatever
      // is on screen for it is about to be about nothing. Ending the hover
      // here rather than in the caller keeps it tied to what invalidates it.
      hooks.onHoverEnd();
      clearMark();
      list.textContent = '';
      for (var i = 0; i < matches.length; i++) {
        var row = document.createElement('div');
        row.className = 'nodino-search-item';
        row.textContent = matches[i];
        bindRow(row, i);
        list.appendChild(row);
      }
      list.classList.toggle('nodino-open', matches.length > 0);
      active = -1;
    }

    input.addEventListener('input', function () {
      var query = input.value.trim();
      // An empty box is not a query that matches everything: it is the
      // absence of one, and offering the first twelve uids in the graph for
      // it would be noise on every focus and every backspace to the start.
      matches = query ? matchesFor(query) : [];
      render();
    });

    // Re-offers the last query when the box is focused again, so a list
    // dismissed by Esc or by a click elsewhere comes back without having to
    // retype it.
    input.addEventListener('focus', function () {
      if (matches.length > 0) list.classList.add('nodino-open');
    });

    // The list is inside the widget's container, so a click on a row is also
    // a click that would blur the input — and the blur that closes the list
    // fires first, removing the row before its own click can land. Taking the
    // press rather than the click keeps the focus where it is; the row's
    // click handler then runs normally.
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });

    // The cursor leaving the list ends the hover, exactly as leaving the
    // canvas does: no row is being read any more, so the card following the
    // cursor is about nothing. Row-to-row movement stays inside the list and
    // does not fire this — only the row's own mouseenter does, which is what
    // moves the hover along.
    list.addEventListener('mouseleave', function () { hooks.onHoverEnd(); });

    input.addEventListener('blur', close);

    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // Only while the list is showing: Esc dismisses it without moving the
        // focus out of the box ([F Search.1]), and walking a list nobody can
        // see — hovering a node a row at a time — is not what the key means.
        if (!list.classList.contains('nodino-open')) return;
        // Held down, an arrow key scrolls the page this is embedded in as
        // well as walking the list. Only these two are claimed; every other
        // key the box receives is the box's own business.
        e.preventDefault();
        var step = e.key === 'ArrowDown' ? 1 : -1;
        // Wraps, and opens at the top going down / at the bottom going up,
        // so the first press in either direction lands somewhere useful
        // rather than being swallowed.
        var next = active < 0
          ? (step > 0 ? 0 : matches.length - 1)
          : (active + step + matches.length) % matches.length;
        read(next);
        return;
      }
      // The keyboard's click, and it pins for the same reason the click does
      // ([D Search.2]) — the arrows having already done the looking.
      if (e.key === 'Enter') {
        choose(active);
        return;
      }
      if (e.key === 'Escape') {
        // Esc releases the pin, document-wide ([F Interact.3]). While the
        // list is open it means the nearer thing first — dismiss the list,
        // and with it the hover it was driving — and the press is stopped
        // here so a pin made from this list survives. With the list closed
        // nothing is claimed and the key does what it does everywhere else.
        if (!list.classList.contains('nodino-open')) return;
        e.stopPropagation();
        close();
      }
    });

    // Called wherever the graph is rebuilt. The uid set is a different set
    // now — and the hover and the pin it was driving were both dropped by the
    // rebuild, which names nodes by nid ([F Interact.3]) — so the box returns
    // to empty rather than showing a query against data that no longer answers
    // it.
    function sync() {
      input.value = '';
      matches = [];
      list.textContent = '';
      close();
    }

    return { sync: sync, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Simulation Controls — built-in Reset/Run/Pause/Force bar plus a state
  // readout. First item of the top-right chrome row, so it sits left of the
  // ⚙ toggle and matches its height. Part of the widget rather than the host's own UI
  // ([F State.2]): driving the lifecycle is the widget's own business, and
  // an embedded host that just wants a graph should not have to reimplement
  // the transition table to get a working Run button. Suppressed with
  // config.showSimControls = false, for a host that does want to own it
  // (onStateChange, [F API.5], is then the way to stay in sync).
  //
  // Never polls: sync(state) is called from setState(), so the bar changes in
  // the same tick the state does.
  // ---------------------------------------------------------------------

  // [action, glyph, label, tooltip] — action keys match TRANSITIONS and the
  // instance methods, so a button *is* its transition, with nothing mapping
  // between the two.
  // Ordered as the run itself goes — start, suspend, push past convergence —
  // with Reset last, apart from that sequence because it leaves it rather
  // than advancing it.
  var SIM_CONTROLS = [
    ['start', '▶', 'Run', 'Start or resume stepping'],
    ['pause', '❙❙', 'Pause', 'Suspend stepping'],
    ['forceContinue', '▶❙', 'Force', 'Continue stepping past this convergence, or resume a paused forced run'],
    ['restart', '↺', 'Reset', 'Replay the layout from its initial frame']
  ];

  function createSimControls(container, actions) {
    var el = document.createElement('div');
    el.className = 'nodino-sim-controls';

    var label = document.createElement('span');
    label.className = 'nodino-sim-state';
    el.appendChild(label);

    var buttons = [];
    SIM_CONTROLS.forEach(function (spec) {
      var button = document.createElement('button');
      var glyph = document.createElement('span');
      glyph.className = 'nodino-sim-glyph';
      glyph.textContent = spec[1];
      button.appendChild(glyph);
      button.appendChild(document.createTextNode(spec[2]));
      button.title = spec[3];
      button.addEventListener('click', function () { actions[spec[0]](); });
      el.appendChild(button);
      buttons.push({ action: spec[0], el: button });
    });

    container.appendChild(el);

    // Illegal transitions grey their button out rather than removing it: the
    // bar keeps a constant size, so it never jumps sideways under the cursor
    // mid-run, and the full set of verbs stays legible as a set — you can see
    // that Force exists before you are allowed to press it. (An earlier
    // version hid Run/Pause/Force instead; besides the jumping, `hidden` was
    // silently defeated by this component's own `display: flex` on the
    // button, which outranks the UA stylesheet's `[hidden] { display: none }`
    // — they stayed visible and clickable, and only the refusal warning in
    // the console gave it away.)
    function sync(state) {
      label.textContent = state;
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].el.disabled = !isTransitionLegal(buttons[i].action, state);
      }
    }

    return { sync: sync, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Stats Readout — how much graph is currently loaded, bottom-right, in
  // small grey type. Deliberately unobtrusive: it answers a question the
  // viewer only occasionally has ("how big is this?"), so it stays legible
  // without competing with the graph. Shows the *sparsified* edge count
  // alongside the input one when they differ ([D Perf.1]), since "3k of 40k
  // edges" is the number that explains the frame rate. Suppressed with
  // config.showStats = false.
  // ---------------------------------------------------------------------

  function createStatsReadout(container) {
    var el = document.createElement('div');
    el.className = 'nodino-stats';
    container.appendChild(el);

    function update(nodeCount, edgeCount, inputEdgeCount) {
      var edges = edgeCount === inputEdgeCount
        ? edgeCount + ' edges'
        : edgeCount + ' of ' + inputEdgeCount + ' edges';
      el.textContent = nodeCount + ' nodes · ' + edges;
    }

    return { update: update, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Run Time Readout — accumulated running time plus total steps, bottom-
  // left, matching the stats readout opposite it. Reads runElapsedMs and
  // frameCount, which both accrue on the same rule the buttons do, so the
  // two agree for free: they advance only while stepping, freeze on pause,
  // resume where they left off, keep counting through a forced run, and
  // return to zero (frameCount to baseFrameCount, [D API.7]) on
  // load()/restart(). The two halves are not symmetric against the
  // convergence budgets ([D Phys.3]): runElapsedMs is *exactly* what
  // maxConvergenceSeconds is spent against, so the seconds shown here and
  // the clock half of the progress bar are one number; the steps shown are
  // frameCount, the layout's cumulative cost, while the budget spends
  // runFrameCount, this run's alone ([D API.7]) — which is why on a restored
  // layout the readout opens at the cached count and the bar opens empty.
  // Suppressed with config.showRunTime = false.
  // ---------------------------------------------------------------------

  function createTimeReadout(container) {
    var el = document.createElement('div');
    el.className = 'nodino-time';
    container.appendChild(el);
    // Last string written, so a per-frame call only touches the DOM when the
    // displayed value actually changes — ten writes a second at this
    // precision, not sixty.
    var shown = null;

    function update(elapsedMs, frames) {
      var text = (elapsedMs / 1000).toFixed(1) + 's · ' + frames + ' steps';
      if (text === shown) return;
      shown = text;
      el.textContent = text;
    }
    update(0, 0);

    return { update: update, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Progress Bar — thin bar anchored to the bottom of the container,
  // tracking progress towards whichever convergence budget ends the run
  // first ([F Phys.4]).
  // Built and torn down with config.showProgressBar by applyChrome(), like
  // every other flagged component ([D Config.3]) — so this reads no config
  // at all: its existence is the flag, and tick() decides the fraction and
  // whether there is a deadline to show, passing both in on each call.
  // ---------------------------------------------------------------------

  function createProgressBar(container) {
    // Static chrome lives in nodino.css (.nodino-progress-bar); only the
    // per-frame visibility/fraction below is set here.
    var el = document.createElement('div');
    el.className = 'nodino-progress-bar';
    container.appendChild(el);

    function update(fraction, visible) {
      el.style.display = visible ? 'block' : 'none';
      if (visible) el.style.transform = 'scaleX(' + Math.max(0, Math.min(1, fraction)) + ')';
    }
    update(0, false);

    return { update: update, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Debug Panel Toggle — small always-on button (top-right corner) that flips
  // config.debug, so the panel is reachable from the UI itself instead of
  // only via host code. Suppressed with config.showDebugToggle = false.
  // ---------------------------------------------------------------------

  function createDebugToggle(container, config, onChange) {
    // Wrapped in its own pill, exactly like .nodino-view-toggle and
    // .nodino-sim-controls: the grey rounded background belongs to the
    // container and the button inside is transparent until active. Purely
    // presentational — a bare button carrying its own background read as a
    // different kind of control from the two pills beside it.
    var el = document.createElement('div');
    el.className = 'nodino-debug-toggle';

    var button = document.createElement('button');
    button.textContent = '⚙';
    button.title = 'Toggle the debug/config panel';
    el.appendChild(button);
    container.appendChild(el);

    function sync() {
      button.classList.toggle('active', !!config.debug);
    }
    sync();

    button.addEventListener('click', function () {
      onChange({ debug: !config.debug });
    });

    return { sync: sync, destroy: function () { container.removeChild(el); } };
  }

  // ---------------------------------------------------------------------
  // Debug Panel — optional, behind config.debug ([D Config.1] / [D Config.6]).
  // ---------------------------------------------------------------------

  function getPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o ? o[k] : undefined; }, obj);
  }

  function setPath(obj, path, value) {
    var parts = path.split('.');
    var last = parts.pop();
    var target = parts.reduce(function (o, k) { o[k] = o[k] || {}; return o[k]; }, obj);
    target[last] = value;
  }

  function createDebugPanel(container, config, onChange, initialRunning) {
    // Static chrome (panel/groups/rows/labels/inputs) lives in nodino.css
    // under .nodino-debug-panel; only structure and per-instance behavior
    // (value binding, cold-field disabling) are set here.
    var el = document.createElement('div');
    el.className = 'nodino-debug-panel';
    container.appendChild(el);

    // Fields are grouped into collapsible <details> sections by feature area —
    // the flat list got too long to scan. All start collapsed so the panel is
    // compact by default; each addGroup() call redirects subsequent fields
    // into the new group's body instead of the panel root.
    var currentGroup = el;

    function addGroup(title) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = title;
      details.appendChild(summary);
      // Fields live in their own body div (not straight in <details>) so
      // nodino.css can separate them from the heading above and the next
      // group's heading below, independently of the summary's own box.
      var body = document.createElement('div');
      body.className = 'nodino-group-body';
      details.appendChild(body);
      el.appendChild(details);
      currentGroup = body;
    }

    function addRow() {
      var row = document.createElement('div');
      row.className = 'nodino-row';
      currentGroup.appendChild(row);
      return row;
    }

    // hint (native title tooltip) goes on the row, so it shows whether the
    // user hovers the label or the input — the input's own title is set
    // separately below so setRunning() can still override just that one
    // while running, without losing the row-level hint elsewhere.
    //
    // A hint also gets a visible "?" badge after the label text. A bare title
    // attribute is invisible: nothing tells you a field is documented at all,
    // so the tooltips went unread. The badge is the affordance; hovering it
    // (or anywhere else on the row) still shows the same native tooltip.
    // Returns the badge so callers can keep its text in sync — see coldInputs.
    function addLabel(row, label, hint) {
      if (hint) row.title = hint;
      var labelEl = document.createElement('label');
      labelEl.appendChild(document.createTextNode(label));
      var help = null;
      if (hint) {
        help = document.createElement('span');
        help.className = 'nodino-help';
        help.textContent = '?';
        help.title = hint;
        labelEl.appendChild(help);
      }
      row.appendChild(labelEl);
      return help;
    }

    // Inputs whose value only takes effect on the next reset (restart/load) —
    // editing them while the simulation is running has no visible effect
    // until then, so they are grayed out for the duration of the run instead
    // of silently doing nothing. See setRunning() below. Each entry keeps its
    // own base hint so setRunning() can append the running-specific note
    // without permanently overwriting the field's description.
    var coldInputs = [];

    // Every bound input, so syncValues() below can re-read config into them.
    // The panel used to be write-only: values were seeded once at
    // construction, and a config change arriving any other way — the host's
    // own updateConfig(), the Attraction/Repulsion lock — left the fields
    // showing numbers that were no longer in force until the panel was closed
    // and reopened.
    var boundFields = [];

    function bindField(input, path, kind) {
      boundFields.push({ input: input, path: path, kind: kind });
    }

    function fieldText(kind, value) {
      return kind === 'bool' ? String(!!value) : String(value);
    }

    function syncValues() {
      for (var i = 0; i < boundFields.length; i++) {
        var field = boundFields[i];
        // Never rewrite the field being typed into: the change event has not
        // fired yet, and replacing the text mid-edit would fight the user.
        if (document.activeElement === field.input) continue;
        var text = fieldText(field.kind, getPath(config, field.path));
        if (field.input.value !== text) field.input.value = text;
      }
    }

    // Shared by every field: validate, refuse the edit if the value is not
    // usable, and only then patch. Restoring the input on refusal is what
    // makes the refusal visible — a silently ignored edit would read as the
    // field having no effect.
    function bindChange(input, path, parse) {
      input.addEventListener('change', function () {
        var value = parse(input.value);
        if (value === undefined) {
          input.value = fieldText(null, getPath(config, path));
          return;
        }
        var patch = {};
        setPath(patch, path, value);
        onChange(patch);
      });
    }

    // An emptied number field yields '' and parseFloat('') is NaN. Let through,
    // NaN reaches physics.damping (or maxStep, or either epsilon) and every
    // node position becomes NaN on the next step — and normalizeToUnitDisk
    // cannot catch it, since `maxR < 1e-12` is false for NaN. The layout is
    // then gone for good: Reset replays it from a config that is still
    // corrupt, so only reloading the page recovers.
    function parseNumber(text) {
      var value = parseFloat(text);
      return isFinite(value) ? value : undefined;
    }

    function addNumberField(path, label, step, hint, cold) {
      var row = addRow();
      var help = addLabel(row, label, hint);
      var input = document.createElement('input');
      input.type = 'number';
      input.step = String(step);
      input.value = getPath(config, path);
      if (hint) input.title = hint;
      bindChange(input, path, parseNumber);
      row.appendChild(input);
      bindField(input, path, 'number');
      if (cold) coldInputs.push({ input: input, help: help, baseHint: hint || '' });
      return input;
    }

    // `kind` picks the accepted shape: 'hex' for the colours canvas takes
    // whole, 'rgb' for the two edge colours, which are bare triplets
    // interpolated into an 'rgba(...)' string per alpha bucket. Both are
    // validated because canvas rejects a malformed colour *silently*, keeping
    // whatever was set last — a bad nodeColor left the nodes painted in the
    // background fill, i.e. invisible, with nothing to say why.
    function addColorField(path, label, hint, kind) {
      var row = addRow();
      addLabel(row, label, hint);
      var input = document.createElement('input');
      input.type = 'text';
      input.value = getPath(config, path);
      if (hint) input.title = hint;
      var pattern = kind === 'rgb' ? RGB_TRIPLET : HEX_COLOR;
      bindChange(input, path, function (text) {
        return pattern.test(text) ? text.trim() : undefined;
      });
      row.appendChild(input);
      bindField(input, path, 'color');
      return input;
    }

    // Boolean fields render as a true/false <select> rather than a checkbox,
    // so they share the same fixed control width as every other field
    // instead of the checkbox's native (much narrower) box.
    function addSelectField(path, label, hint) {
      var row = addRow();
      addLabel(row, label, hint);
      var input = document.createElement('select');
      ['true', 'false'].forEach(function (v) {
        var option = document.createElement('option');
        option.value = v;
        option.textContent = v;
        input.appendChild(option);
      });
      input.value = String(!!getPath(config, path));
      if (hint) input.title = hint;
      input.addEventListener('change', function () {
        var patch = {};
        setPath(patch, path, input.value === 'true');
        onChange(patch);
      });
      row.appendChild(input);
      bindField(input, path, 'bool');
      return input;
    }

    addGroup('Physics & Topology');
    addNumberField('physics.restLength', 'Rest Length', 0.1,
      'Multiplier for optimal edge length: optimal = restLength × (1 − weight).');
    // Only read at engine.reset() (restart()/load()), never inside step() —
    // changing it mid-run has no effect until the next reset, unlike every
    // other physics field below, which the engine re-reads live every step.
    addNumberField('physics.epsilonStart', 'Epsilon Start', 0.001,
      'Initial force multiplier at layout start.', true);
    addNumberField('physics.epsilonMax', 'Epsilon Max', 0.001,
      'Upper bound the force multiplier ramps up to over time.');
    addNumberField('physics.epsilonDelta', 'Epsilon Delta', 0.0001,
      'How much the force multiplier increases per step, up to Epsilon Max.');
    addNumberField('physics.damping', 'Damping', 0.01,
      'Velocity decay per step (0–1); higher values settle the layout faster.');
    addNumberField('physics.maxStep', 'Max Step', 0.01,
      'Hard cap on how far a node can move in one frame, in disk radii.');
    addNumberField('physics.maxConvergenceSeconds', 'Max Converge Seconds', 1,
      'Force the layout to settle after this many seconds of running, if it has not settled naturally yet. Bounds what the user waits; how far the layout gets in that time is up to the machine. 0 = no limit.');
    addNumberField('physics.maxConvergenceFrames', 'Max Converge Frames', 100,
      'Force the layout to settle after this many simulation steps, if it has not settled naturally yet. Bounds the work done, so a fast machine does not lay out several times as much as a slow one for the same wait. 0 = no limit.');
    addNumberField('physics.stopVelocity', 'Stop Velocity', 0.0001,
      'Mean per-frame displacement (post-normalization) below which the layout counts as settling.');
    addNumberField('physics.stopFrames', 'Stop Frames', 1,
      'Consecutive steps below Stop Velocity required before the layout is declared settled.');
    addNumberField('physics.forcedStopVelocity', 'Forced Stop Vel', 0.0001,
      'Stricter Stop Velocity used only while forced past a convergence. Should stay below Stop Velocity, or the forced run settles again immediately.');

    // Lock (on by default): editing one mirrors the other.
    var lockInput = addSelectField('lockAttractionRepulsion', 'Lock Attr/Rep',
      'Keep Attraction and Repulsion mirrored when either one changes.');
    var attractionInput = addNumberField('physics.attraction', 'Attraction', 0.1,
      'Strength multiplier for edges pulling nodes together.');
    var repulsionInput = addNumberField('physics.repulsion', 'Repulsion', 0.1,
      'Strength multiplier for edges and crowding pushing nodes apart.');

    // Registered after each field's own change handler, which has already
    // refused and restored an unusable value by the time this reads it — so
    // the mirror can only ever copy something valid. Guarded anyway: this is
    // the one path that writes a field's value into a *different* config key,
    // and a NaN escaping here would be as unrecoverable as any other.
    function wireLockedMirror(sourceInput, targetInput, targetPath) {
      sourceInput.addEventListener('change', function () {
        if (lockInput.value !== 'true') return;
        var value = parseNumber(sourceInput.value);
        if (value === undefined) return;
        targetInput.value = sourceInput.value;
        var patch = {};
        setPath(patch, targetPath, value);
        onChange(patch);
      });
    }
    wireLockedMirror(attractionInput, repulsionInput, 'physics.repulsion');
    wireLockedMirror(repulsionInput, attractionInput, 'physics.attraction');

    lockInput.addEventListener('change', function () {
      if (lockInput.value !== 'true') return;
      var value = parseNumber(attractionInput.value);
      if (value === undefined) return;
      repulsionInput.value = attractionInput.value;
      var patch = {};
      setPath(patch, 'physics.repulsion', value);
      onChange(patch);
    });

    addNumberField('physics.repulsionSpacing', 'Repulsion Space', 0.1,
      'Crowding radius factor; scaled by 1/√nodeCount to stay density-relative.');
    addNumberField('maxEdgesPerNode', 'Max Edges/Node', 1,
      'Keep only the top-k strongest edges per node, by |weight|; 0 disables pruning.');
    addNumberField('hitThresholdCompute', 'Hit Thr. Compute (+)', 0.05,
      'Minimum positive weight for an edge to exert force.');
    addNumberField('missThresholdCompute', 'Miss Thr. Compute (-)', 0.05,
      'Maximum (least negative) weight for a negative edge to exert force.');

    addGroup('Edges');
    addNumberField('hitThresholdDraw', 'Hit Thr. Draw (+)', 0.05,
      'Minimum positive weight for an edge to be drawn.');
    addNumberField('missThresholdDraw', 'Miss Thr. Draw (-)', 0.05,
      'Maximum (least negative) weight for a negative edge to be drawn.');
    addNumberField('style.edgeWidth', 'Hit Width', 1,
      'Stroke width of positive edges.');
    addNumberField('style.missEdgeWidth', 'Miss Width', 1,
      'Stroke width of negative edges.');
    addNumberField('style.maxHitAlpha', 'Hit Alpha Max', 0.05,
      'Opacity cap for positive edges at |weight| = 1.');
    addNumberField('style.maxMissAlpha', 'Miss Alpha Max', 0.05,
      'Opacity cap for negative edges at |weight| = 1.');
    addNumberField('style.minEdgeAlpha', 'Min Edge Alpha', 0.01,
      'Opacity floor for the weakest visible edges.');
    addColorField('style.hitEdgeColor', 'Hit Color (+)',
      'RGB triplet for positive edges, e.g. "0,0,255".', 'rgb');
    addColorField('style.missEdgeColor', 'Miss Color (-)',
      'RGB triplet for negative edges, e.g. "255,0,0".', 'rgb');

    addGroup('Nodes');
    addNumberField('style.nodeRadius', 'Node Radius', 0.5,
      'Radius of a node circle, in screen pixels (constant regardless of zoom).');
    addNumberField('style.nodeRadiusZoomInThreshold', 'Zoom-In Threshold', 0.5,
      'Node radius starts growing once zoom exceeds this multiple of the fit-to-view zoom level.');
    addNumberField('style.nodeRadiusZoomInExponent', 'Zoom-In Exponent', 0.1,
      'How fast nodes grow past the zoom-in threshold: 0 = not at all, 0.5 = with the square root of zoom, 1 = proportionally.');
    addNumberField('style.nodeRadiusMax', 'Node Radius Max', 0.5,
      'Largest a node can get in screen pixels, however far you zoom in.');
    addNumberField('style.nodeRadiusZoomOutThreshold', 'Zoom-Out Threshold', 0.1,
      'Node radius starts shrinking once zoom drops below this multiple of the fit-to-view zoom level.');
    addNumberField('style.nodeRadiusZoomOutExponent', 'Zoom-Out Exponent', 0.1,
      'How fast nodes shrink past the zoom-out threshold: 0 = not at all, 0.5 = with the square root of zoom, 1 = proportionally.');
    addNumberField('style.nodeRadiusMin', 'Node Radius Min', 0.5,
      'Smallest a node can get in screen pixels, however far you zoom out.');
    addNumberField('style.nodeBorderWidth', 'Node Border Width', 1,
      'Stroke width of the node border; 0 hides it.');
    addColorField('style.nodeColor', 'Node Color',
      'Fill color of nodes. 6-digit hex, e.g. "#000000".');
    addColorField('style.nodeBorderColor', 'Node Border Color',
      'Stroke color of the node border. 6-digit hex, e.g. "#000000".');
    addColorField('style.highlightColor', 'Hover Color',
      'Fill color of the hovered node. 6-digit hex, e.g. "#ffffff".');
    addNumberField('style.highlightBorderWidth', 'Hover Border Width', 0.5,
      'Stroke width of the hovered node\'s border.');
    addColorField('style.highlightBorderColor', 'Hover Border Color',
      'Stroke color of the hovered node\'s border. 6-digit hex, e.g. "#000000".');

    addGroup('Animation');
    addNumberField('style.perimeterWidth', 'Perimeter Width', 1,
      'Stroke width of the boundary circle.');
    addColorField('style.perimeterColor', 'Perimeter Color',
      'Stroke color of the boundary circle. 6-digit hex, e.g. "#000000".');
    addNumberField('style.perimeterIdleAlpha', 'Idle Alpha', 0.05,
      'Perimeter opacity while loaded but not yet started.');
    addNumberField('style.perimeterPulseMinAlpha', 'Pulse Alpha Min', 0.05,
      'Lowest opacity reached by the perimeter pulse while running.');
    addNumberField('style.perimeterPulseMaxAlpha', 'Pulse Alpha Max', 0.05,
      'Highest opacity reached by the perimeter pulse while running.');
    addNumberField('style.perimeterPulseSpeed', 'Pulse Speed (Hz)', 0.1,
      'Perimeter pulse frequency while running, in cycles per second.');
    addNumberField('style.perimeterSettledAlpha', 'Settled Alpha', 0.05,
      'Perimeter opacity once the layout has converged.');
    addNumberField('style.settledTransitionDuration', 'Settle Pulse Ms', 50,
      'Duration of the fade between running and settled/idle states, in ms.');
    addColorField('style.outsideColor', 'Outside Color',
      'Tint outside the boundary circle, shown only around a convergence event. 6-digit hex, e.g. "#f5f5fa".');

    // Last, because it tunes one view rather than the layout every view
    // shares — the groups above are read while a run is being shaped, this
    // one only once there is a result to look at. The cluster fields that
    // stood here are parked with the view itself ([D View.6]): the config
    // keys are still live, they just have no row while nothing can reach
    // the reading.
    addGroup('Proximity');
    // The radius goes first: it is the one field here that changes *what the
    // reading says* rather than how it looks, and the only one that costs a
    // recompute rather than a repaint.
    addNumberField('proximityMaxDistance', 'Radius 2D', 0.05,
      'Two nodes are joined when they lie within this of each other, in world units — the flat layout is a disk of radius 1, so 0.2 is a tenth of its diameter. A node with nothing inside its radius is drawn with no edges at all, which is what makes an outlier read as one. Applied immediately: the reading is rebuilt on the spot.');
    addNumberField('globeProximityMaxDistance', 'Radius 3D', 0.05,
      'The same radius on the globe, measured along the surface. Separate because the sphere has four times the disk\'s area, so nodes sit twice as far apart on it and the flat value finds nothing — the default is the 2D one doubled, which is the same distance in the other geometry\'s units.');
    addColorField('style.proximityEdgeColor', 'Proximity Color',
      'RGB triplet for proximity edges, e.g. "0,140,120". Deliberately not the positive-edge blue: a proximity edge is a different claim.', 'rgb');
    addNumberField('style.proximityEdgeAlpha', 'Proximity Alpha', 0.05,
      'Opacity of proximity edges. One value for all of them — strength is carried by width here, not by alpha.');
    addNumberField('style.proximityEdgeWidth', 'Proximity Width', 0.5,
      'Stroke width of a proximity edge the input says nothing about, and the thin end of the ramp for the ones it does.');
    addNumberField('style.proximityEdgeMaxWidth', 'Proximity Width Max', 0.5,
      'Stroke width where the input weight reaches 1. Between the Hit Draw threshold and 1 the width ramps linearly from Proximity Width to this.');

    // Last of all: the globe shares every other knob above with the plane,
    // which is the point — one physics, one palette, two embeddings
    // ([D Globe.2]). These are the only ones with nothing to tune on a flat
    // layout.
    addGroup('Globe');
    addNumberField('style.globeDepthMinAlpha', 'Depth Min Alpha', 0.02,
      'Floor of the opacity ramp across the sphere\'s depth, against a ceiling of 1 at the near side. Depth is drawn in six slabs, each taking the ramp at its own midpoint, so at 0.12 the far slab is painted at about 0.19 and the near one at about 0.93. 0 hides the back hemisphere entirely — which is half the graph, so it is a deliberate choice rather than a default.');
    addNumberField('style.globeArcSegmentAngle', 'Arc Segment (rad)', 0.05,
      'Arc length per tessellated segment of a surface path. Smaller is smoother and costs more points; edges are short, so most of them are one or two segments either way.');
    addNumberField('style.globeArcMaxSegments', 'Arc Max Segments', 1,
      'Ceiling on that tessellation, so one very long edge cannot cost an unbounded number of points.');
    addNumberField('style.globeGraticuleMeridians', 'Meridians', 1,
      'Lines of longitude on the sphere\'s grid, evenly spaced pole to pole — 12 is one every 30°. Fixed to the world, so they turn with the graph and show that the sphere is rotating rather than rearranging. 0 here and in Parallels turns the grid off; there is no separate switch.');
    addNumberField('style.globeGraticuleParallels', 'Parallels', 1,
      'Lines of latitude, evenly spaced strictly between the poles — 5 is one every 30°. An odd count includes the equator, the only parallel that is also a geodesic.');
    addNumberField('style.globeGraticuleAlpha', 'Graticule Alpha', 0.02,
      'Opacity of the grid before the depth fade. The same fade the graph gets is applied on top, so the far half comes out at this times the far slab\'s multiplier (about 0.19 at the default Depth Min Alpha) — raise this to bring the back of the grid up.');
    addColorField('style.globeGraticuleColor', 'Graticule Color', 'RGB triplet for the grid, e.g. "150,150,180". A pale tint of the chrome\'s ink, deliberately outside the edge palette and deliberately fainter than anything the graph draws: the grid is scaffolding, and a line in the palette\'s blues or reds — or at full ink — reads as a relation. Darken it to make the grid assert itself.', 'rgb');

    function setRunning(running) {
      for (var i = 0; i < coldInputs.length; i++) {
        var entry = coldInputs[i];
        entry.input.disabled = running;
        var hint = running
          ? entry.baseHint + ' Only applied on the next Reset — has no effect while running.'
          : entry.baseHint;
        entry.input.title = hint;
        // The "?" badge is the visible affordance for this hint, so it has to
        // carry the running-specific note too — otherwise the one tooltip a
        // user is actually invited to open is the one that omits the reason
        // the field is greyed out.
        if (entry.help) entry.help.title = hint;
      }
    }
    setRunning(!!initialRunning);

    return {
      destroy: function () { container.removeChild(el); },
      setRunning: setRunning,
      syncValues: syncValues
    };
  }

  // Optional `maxFrames` field of load()'s data ([F Data.4]): the best step
  // count any previous run of this graph reached, as the host has it stored.
  // Anything absent, non-numeric or negative means "no history" rather than
  // an error — a host with nothing cached should be able to leave the field
  // off, and a stored value that got mangled in transit should degrade to
  // that same case instead of poisoning every later comparison.
  function readMaxFrames(data) {
    var value = data && data.maxFrames;
    if (value === undefined || value === null) return 0;
    if (typeof value !== 'number' || !isFinite(value) || value < 0) {
      console.warn('[Nodino] Ignoring invalid data.maxFrames:', value);
      return 0;
    }
    return Math.floor(value);
  }

  // Graph identity hash, for a host caching converged layouts server-side
  // ([Opn 3]): the same input uid *set* must hash the same way regardless of
  // how the host iterated it, which is exactly what nid assignment already
  // guarantees ([F Data.2]) — uids joined in their sorted (nid) order, not
  // re-sorted here.
  //
  // cyrb53 (bryc, public domain) rather than MD5: it is a cache key, not a
  // security boundary, so cryptographic strength buys nothing and costs ~10x
  // the code for a hand-rolled MD5 with no external dependency allowed
  // ([F Det.1]'s no-build-step constraint rules out pulling one in). It is
  // also synchronous — unlike SubtleCrypto's digest(), which returns a
  // Promise and could not be read back inside the same tick that fires
  // onSettle. 53 bits keeps collisions negligible at the graph counts this
  // is for; a non-cryptographic hash cannot promise more than that, and
  // nothing here needs it to.
  function hashUids(uids) {
    var str = uids.join(',');
    var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (var i = 0; i < str.length; i++) {
      var ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    var n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
    return n.toString(16);
  }

  // Step rate used while the page is hidden, in ms. Matches a 60fps display
  // closely enough that a run does not visibly change pace when the window is
  // switched away and back — and since the layout is a function of the step
  // *count* ([F Det.1]), the exact rate cannot change the result either way.
  var BACKGROUND_TICK_MS = 16;

  // Drives the simulation while requestAnimationFrame is not delivering
  // callbacks ([D Phys.4]). The browser suspends rAF outright for a hidden
  // page, so a run left in a background window used to stop dead until the
  // window came back — the layout does not need to be *seen* to advance, and
  // switching to another application for a minute should cost nothing.
  //
  // The tick comes from a dedicated worker rather than a plain setInterval
  // here: a hidden page's own timers are clamped to 1 Hz, and to one per
  // minute after five minutes hidden, which would leave the simulation
  // technically alive and practically frozen. A worker's timers are exempt
  // from that clamping. The worker does nothing but post an empty message on
  // an interval — no physics crosses the thread boundary, so nothing about
  // the engine or its typed arrays has to become transferable.
  function createBackgroundTicker(onTick) {
    var source = 'var id=0;' +
      'onmessage=function(e){' +
        'if(e.data){if(!id)id=setInterval(function(){postMessage(0);},e.data);}' +
        'else{clearInterval(id);id=0;}' +
      '};';
    var worker = null;
    var intervalId = 0;

    // The fallback, for when the worker is unavailable: a plain interval, which
    // a hidden page throttles, so the run crawls rather than continuing at
    // speed. Crawling still beats stopping, and this is the only part of the
    // feature a host's CSP can take away.
    function fallBackToInterval() {
      stopWorker();
      if (!intervalId) intervalId = setInterval(onTick, BACKGROUND_TICK_MS);
    }

    function stopWorker() {
      if (!worker) return;
      // Cleared before terminate() so neither handler can fire afterwards —
      // in particular onerror, which would otherwise resurrect the fallback
      // for a ticker that has just been stopped on purpose.
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      worker = null;
    }

    try {
      var url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(url);
      // Safe immediately: the worker already holds its own reference to the
      // script, and leaving the object URL alive would leak one per switch.
      URL.revokeObjectURL(url);
      worker.onmessage = onTick;
      // A Content-Security-Policy without `worker-src blob:` usually makes the
      // constructor above throw, but not everywhere — some browsers report a
      // blocked or broken worker asynchronously instead, which would leave a
      // ticker that never ticks and a simulation silently stopped. So the
      // failure is caught from both directions.
      worker.onerror = fallBackToInterval;
      worker.postMessage(BACKGROUND_TICK_MS);
    } catch (err) {
      fallBackToInterval();
    }

    return {
      stop: function () {
        stopWorker();
        if (intervalId) { clearInterval(intervalId); intervalId = 0; }
      }
    };
  }

  // ---------------------------------------------------------------------
  // Public API ([F API.1], [F API.2])
  // ---------------------------------------------------------------------

  /**
   * @param {HTMLElement} container
   * @param {{ config?: object,
   *           onStateChange?: (state: NodinoState) => void }} [options]
   *   Instance-level only. Anything scoped to a *dataset* — `onNodeHover`, `onNodePin`,
   *   per-dataset config — goes to load() instead ([D API.2]).
   *
   *   `onStateChange` fires on every lifecycle transition ([F State.1]),
   *   including the two the engine makes on its own (reaching convergence) —
   *   the way for a host to mirror lifecycle state into its own UI without
   *   polling getStats(). Not called for the initial 'empty'.
   *
   * @typedef {{ frames: number, maxFrames: number, state: NodinoState,
   *             reason: 'converged'|'capped'|'timeout'|'paused',
   *             hash: string }} NodinoResult - payload of onSettle and onPause alike
   *
   * @typedef {{ onNodeHover?: (node: { uid: string, m: object|null },
   *                            body: HTMLElement) => any,
   *             onNodePin?: (node: { uid: string, m: object|null },
   *                          body: HTMLElement) => any,
   *             onSettle?: (result: NodinoResult) => void,
   *             onPause?: (result: NodinoResult) => void,
   *             config?: object }} NodinoLoadOptions - second argument to load()
   *
   *   `onPause` fires on every pause, with the same payload shape as
   *   `onSettle` and `reason: 'paused'` — a suspended layout is worth exactly
   *   the steps that produced it and is as cacheable as a converged one, so
   *   the same server-side store can be offered both. It does not raise the
   *   high-water mark: pausing is mid-run, and a run still going must not
   *   overwrite a record it has not finished beating ([F API.7]).
   *
   *   `onSettle` fires each time the layout converges — ordinary and forced
   *   convergence alike, `result.state` being 'settled' or 'forced_settled'.
   *   `frames` is what the converged layout cost in steps — this run's own,
   *   plus the cached count it started from if the data restored a layout
   *   ([D API.7]); `maxFrames` the best any *previous* run of this graph
   *   reached, seeded from `data.maxFrames` and raised as runs beat it, so
   *   `frames > maxFrames` means this layout is further along than anything
   *   on record for the graph. `reason` says which way the run ended:
   *   'converged' if the layout stopped moving, 'capped' if
   *   physics.maxConvergenceFrames ended it first, 'timeout' if
   *   physics.maxConvergenceSeconds did. Both budgets count this run only, so
   *   a restored layout stopped by one of them stops that far past where it
   *   resumed. Every ending raises the mark; deciding what is worth keeping
   *   is the handler's job, and `frames > maxFrames` alone is not that
   *   decision ([D API.8]).
   *
   *   `hash` identifies the graph's uid *set*, for a host keying a
   *   server-side cache off it ([Opn 3]): the same set always hashes the
   *   same way, in any host iteration order, since it's computed from the
   *   set sorted once at build time ([F Data.2]), never from host input
   *   order. Computed once per (re)loaded graph, at its first convergence,
   *   and reused for every later onSettle of that same graph — a
   *   forceContinue() past 'settled' reports the same hash its 'settled'
   *   payload did.
   *
   *   `onNodeHover` is handed the node and the detail panel's body element —
   *   an empty div under the uid title, cleared before every call. Fill it
   *   directly (any DOM, listeners included), or return an HTML string or a
   *   Promise of one and let the panel fill it; a returned value lands last
   *   and wins. Return nothing to leave the title as the only content.
   *   Loading and error states are the handler's own: while a returned
   *   promise is in flight the slot holds whatever the handler put there.
   *
   *   `onNodePin` is the same contract for the card a click pins
   *   ([F Interact.3]), which is the one that takes the mouse — put the
   *   buttons and links here, where they can be used. Omit it and the pinned
   *   card is filled by `onNodeHover` instead ([D API.11]), so a host that
   *   has nothing extra to offer when clickable supplies one handler and gets
   *   the same content in both.
   */
  function create(container, options) {
    options = options || {};
    var config = deepMerge(cloneDefaultConfig(), options.config);
    var log = createLogger(config);

    // Read the *computed* position (container.style only reflects inline styles,
    // missing a position already set via an external/embedded stylesheet — e.g.
    // a host using `position: fixed` on the container — and clobbering it with
    // 'relative' below).
    var containerPosition = global.getComputedStyle
      ? global.getComputedStyle(container).position
      : container.style.position;
    // Whatever was on the element before, so destroy() can put it back:
    // create() borrows the container, it does not take it over, and an
    // instance that has been torn down should leave no trace on a host
    // element the page may go on using.
    var hostPosition = container.style.position;
    var hostOverflow = container.style.overflow;
    if (!containerPosition || containerPosition === 'static') {
      container.style.position = 'relative';
    }
    container.style.overflow = 'hidden';

    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;';
    container.appendChild(canvas);

    // Raw input is retained so topology settings (maxEdgesPerNode) can be
    // re-applied without the host handing the data over again. create() never carries data itself — the graph starts empty and
    // is populated exclusively through load().
    var world = {
      state: buildGraphState({}, [], {}, config.maxEdgesPerNode),
      perimeterRadius: 0,
      rawData: { nodes: {}, edges: [] },
      // The 'proximity'/'clusters' readings ([D View.5], [D View.6]), each
      // computed on entering the view that needs it and held until the
      // positions it describes can change. null = nothing computed.
      view: null
    };
    var worldRadius = layoutInitial(world.state);
    layoutInitialGlobe(world.state);
    world.perimeterRadius = worldRadius;

    var renderer = createRenderer(canvas, world, config);
    renderer.resize();
    renderer.fitView(worldRadius);

    // Two layouts, two indices, two engines, stepped together ([D Globe.6]).
    // The sphere is also radius 1, so it needs no separate perimeter radius,
    // no separate base zoom and no separate pan bound — the camera machinery
    // is shared whole.
    var grid = createGrid(repulsionRadiusFor(world.state.count, config.physics));
    var grid3 = createGrid3(repulsionRadiusForGlobe(world.state.count, config.physics));
    var engine = createEngine(world, config, grid, 'plane');
    var globeEngine = createEngine(world, config, grid3, 'globe');

    // The lifecycle has one notion of "settled" and there are now two layouts,
    // so a run is over when *both* are. The alternative — following whichever
    // geometry is on screen — would make a view toggle change the simulation
    // state, which is precisely what [D View.1] forbids for the reading toggle
    // and forbids here for the same reason: switching what you are looking at
    // must not restart, resume or end a run.
    function bothSettled() {
      return engine.isSettled() && globeEngine.isSettled();
    }
    // Two cards, both always present and both usually hidden: the one that
    // follows the cursor and the one a click pins ([F Interact.3]). Built once
    // each rather than one card changing hands, because both can be on screen
    // at the same time — hovering is what a pin is moved *with*.
    var hoverPanel = createDetailPanel(container, false);
    var pinPanel = createDetailPanel(container, true);
    // Every optional chrome component starts null and is built by
    // applyChrome() below, which is also what updateConfig() calls — so the
    // show* flags behave identically whether they arrive at create() or long
    // afterwards. Declared here (before the state machine) because setState()
    // syncs simControls; built after it, since their handlers call the
    // lifecycle verbs.
    var debugPanel = null;
    var viewModeToggle = null;
    var geometryToggle = null;
    var searchBar = null;
    var debugToggle = null;
    var simControls = null;
    var statsReadout = null;
    var timeReadout = null;
    var progressBar = null;

    // The top-right chrome row. A single flex container anchored to the
    // corner, holding the simulation controls and the ⚙ toggle: because it
    // shrink-wraps its children and is pinned by its right edge, whatever is
    // present packs against the corner on its own, with no gap where a hidden
    // component used to be — replacing an earlier per-component "am I the one
    // at the edge?" rule that only ever covered one of the combinations.
    // Order within the row is fixed in CSS (`order`), not by insertion, so
    // components appearing and disappearing through updateConfig() can never
    // reshuffle it. The debug panel is not in here — it hangs below the row,
    // positioned against the same corner.
    var chromeRow = document.createElement('div');
    chromeRow.className = 'nodino-chrome-row';
    container.appendChild(chromeRow);

    // The top-centre row, holding the geometry toggle and the view-mode
    // toggle in that order. A shared flex row rather than each pill placing
    // itself: the view toggle centres by shrink-wrapping its own content and
    // offsetting by half of it, and that argument only survives if the thing
    // being centred is the *row* once there are two of them. Positioning the
    // second pill against a hand-computed offset from the first is exactly
    // the fixed-width-plus-calc() approach that had already gone stale once
    // (see nodino.css).
    var viewRow = document.createElement('div');
    viewRow.className = 'nodino-view-row';
    container.appendChild(viewRow);

    // Bound per dataset by load(), not at create(): what a card should show is
    // a property of the data being shown ([D API.2]). Null until the first
    // load() supplies one — and null again after any load() that doesn't.
    //
    // Two of them, one per card ([D API.11]): the hovering card is read at a
    // glance and cannot be clicked, the pinned one is read at leisure and can,
    // so what belongs in each is a different question and the host answers it
    // twice. `pinHandler` falls back to `hoverHandler` when the dataset
    // supplies only the one.
    var hoverHandler = null;
    var pinHandler = null;

    // Likewise bound per dataset ([D API.6]): what to do with a converged
    // layout — cache it, upload it, compare it against a previous run — is a
    // question about *this* graph, and its companion input (data.maxFrames,
    // the best any previous run of this graph reached) arrives with the data
    // in the same call.
    var settleHandler = null;

    // Same reasoning, same call ([D API.6]): a suspended layout is as
    // cacheable as a converged one, and what to do with it is a question
    // about this dataset.
    var pauseHandler = null;

    // --- Lifecycle state machine ([F State.1]) ---------------------------
    // The single source of truth for "what is this instance doing". Every
    // other lifecycle flag that used to live here (running / hasStarted /
    // convergenceCapDisabled) is now *derived* from it, so they cannot drift
    // out of sync with each other — which is exactly how resuming a paused
    // forced run used to silently re-arm the convergence cap.
    //
    // Two of the nine states are reached by the engine rather than by the
    // host (RUNNING -> SETTLED, FORCED -> FORCED_SETTLED); all the others are
    // host-driven, via start()/pause()/forceContinue()/load()/restart()/
    // destroy().
    // An instance starts with no data at all, which is a state of its own:
    // 'empty' looks like 'loaded' but has nothing to run, so start() and
    // restart() are refused there rather than putting the engine into a run
    // that can never converge (step() bails on n === 0, so only the
    // convergence cap would ever end it). Legal transitions live in the
    // module-level TRANSITIONS table.
    var state = 'empty';

    // Actively stepping the physics. Note FORCED counts: it is a run like any
    // other, only with the step cap waived and a stricter stop threshold.
    function isRunningState() {
      return state === 'running' || state === 'forced';
    }

    // Nodes have left the initial circle at least once since the last
    // load()/restart(). Drives the perimeter's resting alpha in draw()
    // (status.hasStarted): only 'empty'/'loaded' show the flat idle alpha,
    // every other state gets the pulse — pausing mid-run leaves the nodes
    // scattered and the pulse clock frozen, which is a run, not an idle.
    function hasStartedState() {
      return state !== 'loaded' && state !== 'empty' && state !== 'destroyed';
    }

    // Converged, organically or forced ([F Phys.4]/[D State.2]) — the
    // coarser reading getStats() exposes as `settled` ([F API.5]) and the
    // one the automatic switch to an output reading fires on ([D View.1]).
    function isSettledState() {
      return state === 'settled' || state === 'forced_settled';
    }

    // Not stepping — which is a wider set than "converged": it takes in
    // 'loaded' (never started), both paused states, and both settled ones.
    // This, not convergence, is what gates the Proximity button ([D View.2]): the
    // objection to offering an output reading was always that the layout
    // underneath was still moving, and a suspended run is as still as a
    // finished one. 'destroyed' is excluded because there is no toggle left
    // to gate.
    function isStoppedState() {
      return !isRunningState() && state !== 'destroyed';
    }

    // `force` re-runs the whole body for a transition that lands where it
    // started. Only load() sets it, and only because a self-loop there is a
    // real event: `loaded -> loaded` and `empty -> empty` are drawn as
    // transitions in the state machine ([F State.1]) because the *data*
    // changed even though its name did not, and a host mirroring lifecycle
    // state — or simply waiting to hear that its load() landed — would
    // otherwise be told nothing at all. Every sync below is idempotent, so
    // repeating them costs a few no-op DOM reads on a call the host made
    // anyway; nothing in the frame loop reaches this path.
    function setState(next, force) {
      if (next === state && !force) return;
      log('state', state + ' -> ' + next);
      state = next;
      // Single choke point for [D View.4]: entering motion forces the reading
      // back to 'relations' and drops the cached readings, because the
      // positions they describe are about to change and their buttons are
      // about to go dark. Every verb that starts the layout moving used to
      // have to remember this for itself, and each one that forgot produced
      // the same stranded state — an output reading over a moving graph, with
      // no control on screen to leave it.
      //
      // Assigned directly rather than through setViewMode(): this runs inside
      // setState(), and the syncs immediately below are exactly what that
      // call would have triggered. Gated the way setViewMode() is, though,
      // and for the same reason ([D View.3]): with the toggle hidden the host
      // owns config.viewMode outright, and a reset here would take its chosen
      // reading away with no control on screen to get it back — permanently,
      // since the switch back on convergence is gated too and would never
      // return it. The cache is dropped either way: the positions it
      // describes are about to move, whoever chose the mode.
      if (isRunningState()) {
        if (config.showViewModeToggle) config.viewMode = 'relations';
        world.view = null;
        needsRedraw = true;
      } else if (isStoppedState()) {
        // ...and the other half of the same choke point: entering a *stopped*
        // state, make sure the reading about to be displayed has actually been
        // computed. `isStoppedState()` rather than a bare else, so that
        // 'destroyed' — which is not running either — does not get a reading
        // computed for a widget being torn down.
        //
        // Invalidating the cache and rebuilding it were split across
        // two places that only coincided by luck — `world.view = null` here and
        // in restart(), the rebuild only ever as a side effect of
        // updateConfig() — and every path that invalidated without also
        // changing a config field left the reading blank.
        //
        // load() was the one that showed it: it invalidates through restart(),
        // then asks for 'proximity', and setViewMode() short-circuits when the
        // mode is *already* proximity — which it is, coming from a converged
        // graph — so no updateConfig() ran and no rebuild happened. Importing a
        // layout while already in Proximity drew no edges until the mode was
        // toggled away and back. A host that hid the toggle had the same bug
        // permanently, setViewMode() being a no-op for it outright ([D View.3]).
        //
        // Cheap to call unconditionally: ensureView() returns immediately in
        // 'relations', on an empty graph, and whenever the reading it needs is
        // already cached.
        ensureView();
      }
      if (debugPanel) debugPanel.setRunning(isRunningState());
      if (simControls) simControls.sync(state);
      // Authoritative resync point for the Proximity button's state: some
      // callers set config.viewMode (via setViewMode()) *before* calling
      // setState() — e.g. load() landing straight on 'settled' for a
      // restored layout ([D Data.3]) — so a sync() driven only from that
      // config change would run against the state this instance is about to
      // leave, not the one it is entering, and could grey Proximity out the instant
      // it should appear. Syncing here too closes that gap regardless of
      // call order.
      if (viewModeToggle) viewModeToggle.sync(isStoppedState());
      // Which driver steps the simulation is a function of the state and of
      // page visibility ([D Phys.4]) — so it is reconciled here, on the one
      // event that can change the first of the two.
      syncDriver();
      if (typeof options.onStateChange === 'function') {
        log('cb', 'onStateChange', state);
        options.onStateChange(state);
      }
    }

    function refuse(action) {
      console.warn('[Nodino] ' + action + '() ignored: not allowed in state "' + state + '".');
      return false;
    }

    // Shared by the four table-driven verbs: look the action up in
    // TRANSITIONS, refuse (warn + no-op) if the current state has no entry.
    // `onEnter` (the engine work a transition needs, if any) runs *before*
    // setState, so an onStateChange listener observes an instance already in
    // the state it is being told about.
    function applyTransition(action, onEnter) {
      var next = TRANSITIONS[action][state];
      if (!next) return refuse(action);
      if (onEnter) onEnter();
      setState(next);
      return true;
    }

    var destroyed = false;
    var needsRedraw = true;
    var hoveredNid = -1;
    // The pinned node, or -1 ([F Interact.3]). One at a time, and independent
    // of `hoveredNid`: hovering carries on while a pin holds, because moving
    // the pin from one node to another begins by looking at the other one.
    var pinnedNid = -1;
    // Where the pinned panel was last placed, in client coordinates rounded
    // to whole pixels — the guard that keeps followPin() from measuring the DOM
    // on frames where the node has not actually moved on screen.
    var pinnedX = -1, pinnedY = -1;

    function nodeAt(nid) {
      return { uid: world.state.uids[nid], m: world.state.metadata[nid] };
    }

    function onHover(nid, clientX, clientY) {
      // The pinned node is exempt: it already has a card of its own, anchored
      // to it and holding exactly this content, so a second one under the
      // cursor would be the same node twice — and would re-run the host's
      // handler to say it ([D API.4]).
      if (nid === pinnedNid) {
        clearHover();
        return;
      }
      // Repositioned on every mousemove, but repopulated only when the node
      // under the cursor actually changes. show() runs the host's
      // onNodeHover, and mousemove fires many times a second over a single
      // node: re-running it per move would re-issue the host's fetch at
      // framerate, and tear down whatever DOM it injected into the body
      // (losing its listeners) only to rebuild it — flickering the host's own
      // loading placeholder back on every pixel of movement.
      if (nid === hoveredNid) {
        hoverPanel.moveTo(clientX, clientY);
        return;
      }
      hoveredNid = nid;
      renderer.setHighlighted(nid);
      needsRedraw = true;
      // Shown whether or not a handler was supplied: the uid title is the
      // panel's default content, and the handler only adds to it.
      hoverPanel.show(nodeAt(nid), clientX, clientY, hoverHandler);
    }

    // Ends the hover and nothing else — a pin is not a hover that lasted
    // longer, and every caller here means one or the other.
    function clearHover() {
      if (hoveredNid !== -1) {
        hoveredNid = -1;
        renderer.setHighlighted(-1);
        needsRedraw = true;
      }
      hoverPanel.hide();
    }

    function onHoverEnd() {
      clearHover();
    }

    // Pins a node's card ([F Interact.3]). The same call moves the pin from
    // one node to another, since nothing about the outgoing pin outlives it:
    // show() clears the body and re-runs the pin handler for the new node,
    // exactly as a change of hovered node does for the other card ([D API.4]).
    function pin(nid, clientX, clientY) {
      pinnedNid = nid;
      pinnedX = -1; pinnedY = -1;
      renderer.setPinned(nid);
      // The hover that led here is over: the card under the cursor and the one
      // about to be pinned are the same node, and the hovering one would sit
      // duplicated on top of it. Hovering resumes on the next node.
      clearHover();
      needsRedraw = true;
      // Placed at the cursor for this one call and at its node from the next
      // drawn frame on — the two are within a hit radius of each other, so
      // the handover is not visible, and going through show() keeps the
      // measure-then-place ordering async content depends on ([D API.6a]).
      pinPanel.show(nodeAt(nid), clientX, clientY, pinHandler);
    }

    // Returns whether there was a pin to release, so callers that only want
    // to act when there was one (Esc) do not have to ask twice.
    function unpin() {
      if (pinnedNid === -1) return false;
      pinnedNid = -1;
      renderer.setPinned(-1);
      needsRedraw = true;
      pinPanel.hide();
      return true;
    }

    // One click, three outcomes, and which one applies is decided entirely by
    // what was under the cursor ([D Interact.5]): the background releases,
    // the pinned node itself toggles off, any other node takes the pin.
    function onClick(nid, clientX, clientY) {
      if (nid < 0 || nid === pinnedNid) {
        if (unpin()) log('ui', 'node unpinned');
        return;
      }
      log('ui', 'node pinned', world.state.uids[nid]);
      pin(nid, clientX, clientY);
    }

    // Pinning a node named from outside ([F API.10]) — the public pin(), and
    // what every row of the search list reaches. Deliberately the *same*
    // pin() a click reaches and nothing more: one pin at a time, moved rather
    // than added, released by the same four routes ([F Interact.3]). A
    // programmatic pin that behaved even slightly differently would be a
    // second feature wearing the first one's name.
    //
    // The anchor is the node's own screen position instead of a cursor there
    // is none of — which is where the panel would have ended up anyway, since
    // followPin() re-places it there on the next drawn frame ([F Interact.3]).
    // On the globe that includes nodes on the far side: nodeScreenPos()
    // projects them to the point inside the silhouette where they are drawn,
    // and the card belongs where the node is, visible or not.
    //
    // The camera is not moved ([D Interact.2]): where someone is looking is
    // theirs, and a search that panned the view out from under them would be
    // taking it. The consequence is stated rather than papered over — pinning
    // a node that is off screen at the current zoom puts its card off screen
    // with it, the container clipping both ([Rsk Search.1]).
    //
    // Returns whether it pinned, so a caller that named a node this graph
    // does not have can tell. `uid` is String()-ed because that is what the
    // uid set holds ([F Data.2]): a host that keyed its nodes with numbers
    // gets the node it meant rather than a warning about a uid it can see in
    // its own data.
    function pinByUid(uid) {
      var nid = world.state.uidToNid.get(String(uid));
      if (nid === undefined) {
        console.warn('Nodino: pin(): no node with uid', uid);
        return false;
      }
      var pos = renderer.nodeScreenPos(nid);
      if (!pos) return false;
      var rect = canvas.getBoundingClientRect();
      pin(nid, rect.left + pos[0], rect.top + pos[1]);
      return true;
    }

    // The other half of the pair ([F API.11]): hovering a node named from
    // outside, which is what a row of the search list under the cursor means
    // ([D Search.2]). Same construction as pinByUid() and for the same
    // reasons — the node's own screen position for an anchor, `String()` on
    // the way in, `false` for a uid this graph does not have.
    //
    // It goes through onHover() rather than around it, so the two exemptions
    // that make hovering what it is hold here too: a repeat of the node
    // already hovered only re-places the card instead of re-running the
    // host's handler ([D API.4]), and the pinned node shows nothing further,
    // having a card of its own already. `true` therefore means "hovering that
    // node is what happened", which for the pinned node is nothing.
    function hoverByUid(uid) {
      var nid = world.state.uidToNid.get(String(uid));
      if (nid === undefined) {
        console.warn('Nodino: hover(): no node with uid', uid);
        return false;
      }
      var pos = renderer.nodeScreenPos(nid);
      if (!pos) return false;
      var rect = canvas.getBoundingClientRect();
      onHover(nid, rect.left + pos[0], rect.top + pos[1]);
      return true;
    }

    // Ends a hover from outside. Returns whether there was one, mirroring
    // unpin(), so a caller that only wants to act when something was showing
    // does not have to ask twice.
    function endHover() {
      if (hoveredNid === -1) return false;
      clearHover();
      return true;
    }

    // Re-anchors the pinned panel to its node. Called from the draw path, so
    // it runs exactly when something that could have moved the node on screen
    // has been drawn — a step of the simulation, a pan, a zoom, a rotation —
    // and never on a settled graph nobody is touching. moveTo() measures both
    // the panel and the container, so the whole-pixel guard is what keeps a
    // running layout from forcing two extra reflows a frame for a panel that
    // would land in the same place.
    function followPin() {
      if (pinnedNid === -1) return;
      var pos = renderer.nodeScreenPos(pinnedNid);
      if (!pos) return;
      var rect = canvas.getBoundingClientRect();
      var cx = Math.round(rect.left + pos[0]);
      var cy = Math.round(rect.top + pos[1]);
      if (cx === pinnedX && cy === pinnedY) return;
      pinnedX = cx;
      pinnedY = cy;
      pinPanel.moveTo(cx, cy);
    }

    // Esc releases the pin: the keyboard half of clicking the background, and
    // the dismissal that still works when host content has grown the panel to
    // the point where there is little background left within easy reach. On
    // the document because the canvas is not focusable and a floating panel is
    // dismissed by the key whatever has focus; removed in destroy(), like the
    // one other listener this instance puts outside its own container. Not
    // preventDefault-ed — an Esc that also closes the host's own dialog is the
    // host's business, and this has no claim on the key.
    function onKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (unpin()) log('ui', 'node unpinned (Esc)');
    }
    document.addEventListener('keydown', onKeyDown);

    function onViewChange() { needsRedraw = true; }

    var interaction = attachInteraction(canvas, renderer, grid, grid3, world, {
      onHover: onHover,
      onHoverEnd: onHoverEnd,
      onClick: onClick,
      onViewChange: onViewChange
    });

    function resize() {
      renderer.resize();
      needsRedraw = true;
    }

    var resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    // Build or tear down one optional component to match its flag, returning
    // what the caller should now hold. Called on every updateConfig(), so a
    // show* flag is never a create()-only setting that silently does nothing
    // later — which is exactly what three of them used to be.
    function syncComponent(wanted, current, build) {
      if (wanted && !current) return build();
      if (!wanted && current) { current.destroy(); return null; }
      return current;
    }

    // Marks a verb as having been reached from the widget's own controls
    // rather than from host code. The two run identical paths — a button *is*
    // its transition ([F State.2]) — so the trace is the only place the
    // distinction survives, and it is exactly the question being asked when a
    // lifecycle sequence has to be reconstructed after the fact.
    function fromControls(name, verb) {
      return function () {
        log('ui', name + ' pressed');
        verb();
      };
    }

    // Same, for the chrome that changes config instead of state — the two
    // toggles and the debug panel, all of which reach updateConfig(). The
    // 'api updateConfig' line follows on its own; this says who asked.
    function fromControlsConfig(name) {
      return function (patch) {
        log('ui', name, patch);
        updateConfig(patch);
      };
    }

    function applyChrome() {
      // showDebugToggle gates the whole config feature, panel included — not
      // just its button. Hiding it while the panel happened to be open would
      // otherwise strand a panel on screen with nothing left to close it.
      // `debug` still decides whether the panel is open *within* a feature
      // that is being shown at all.
      var showPanel = config.debug && config.showDebugToggle;
      // Built by hand rather than through syncComponent: unlike the others it
      // needs the current running state handed to it, so that a panel opened
      // mid-run starts with its reset-only fields already disabled.
      if (showPanel && !debugPanel) {
        debugPanel = createDebugPanel(container, config, fromControlsConfig('debug panel'), isRunningState());
      } else if (!showPanel && debugPanel) {
        debugPanel.destroy();
        debugPanel = null;
      }

      geometryToggle = syncComponent(config.showGeometryToggle, geometryToggle, function () {
        return createGeometryToggle(viewRow, config, fromControlsConfig('geometry'));
      });
      viewModeToggle = syncComponent(config.showViewModeToggle, viewModeToggle, function () {
        return createViewModeToggle(viewRow, config, fromControlsConfig('view mode'), isStoppedState());
      });
      // Reads the uid list through a getter rather than being handed the
      // array: world.state is replaced outright on every rebuild ([D API.1]),
      // and a bar holding the old one would go on offering nodes that are no
      // longer in the graph.
      //
      // The three verbs are the same three the canvas hands to interaction
      // ([D Interact.4]) — hover, end hover, choose — because a row of the
      // list is the node it names ([D Search.2]). The hover is not traced: it
      // is a look and it fires per row, which is exactly why [D Config.7]
      // keeps the canvas hover out of the log too. The pick is.
      searchBar = syncComponent(config.showSearch, searchBar, function () {
        return createSearchBar(viewRow, {
          getUids: function () { return world.state.uids; },
          onHover: hoverByUid,
          onHoverEnd: endHover,
          onPick: function (uid) {
            log('ui', 'search pick', uid);
            pinByUid(uid);
          }
        });
      });
      debugToggle = syncComponent(config.showDebugToggle, debugToggle, function () {
        return createDebugToggle(chromeRow, config, fromControlsConfig('debug toggle'));
      });
      // The lifecycle verbs are function declarations, so they are already
      // bound by the time a button can be clicked. Passing them by name
      // (rather than the state machine calling into the bar) keeps the bar a
      // pure renderer of state: it can only ask for transitions, never
      // perform one.
      simControls = syncComponent(config.showSimControls, simControls, function () {
        var controls = createSimControls(chromeRow, {
          restart: fromControls('restart', restartAndStop),
          start: fromControls('start', start),
          pause: fromControls('pause', pause),
          forceContinue: fromControls('forceContinue', forceContinue)
        });
        controls.sync(state);
        return controls;
      });
      statsReadout = syncComponent(config.showStats, statsReadout, function () {
        return createStatsReadout(container);
      });
      syncStatsReadout();
      timeReadout = syncComponent(config.showRunTime, timeReadout, function () {
        return createTimeReadout(container);
      });
      // A readout switched on mid-run would otherwise sit at 0.0s until the
      // next frame; harmless, but it flashes a wrong number.
      if (timeReadout) timeReadout.update(runElapsedMs, frameCount);
      // Built and torn down like every other flagged component ([D Config.3]),
      // rather than built once and merely hidden: `showProgressBar` was the
      // one flag that left its component in the host's DOM after being turned
      // off. Whether the bar is *visible* while it exists is a separate
      // question, and tick() still answers it — one frame later at worst,
      // since tick() runs whatever the state.
      progressBar = syncComponent(config.showProgressBar, progressBar, function () {
        return createProgressBar(container);
      });
    }

    // Driven by the data, not by config or by the frame loop — so it is
    // refreshed wherever the graph is (re)built, and once here for the case
    // where the readout itself has just been switched back on.
    function syncStatsReadout() {
      if (!statsReadout) return;
      statsReadout.update(
        world.state.count, world.state.edgeCount, world.state.inputEdgeCount
      );
    }
    // Accumulated running time, for the bottom-left readout, the perimeter's
    // pulse phase, and — since the convergence guarantee gained a wall-clock
    // budget alongside the step one ([D Phys.3]) — physics.maxConvergenceSeconds
    // as well. One clock serving all three is what makes the budget stop
    // accruing on a pause without a line of its own, and what makes the
    // readout show exactly how much of it has been spent ([D Render.4]). It
    // accrues only while actually running: paused/idle stretches don't count. lastRunTime anchors the
    // delta between consecutive running frames; -1 means "not currently
    // accumulating" (paused, idle, or the very first running frame after
    // one of those), so that frame contributes no (spurious) delta.
    //
    // Declared above applyChrome() because the run-time readout it builds
    // seeds itself from runElapsedMs — below, `var` hoisting would hand it
    // undefined and it would render NaN.
    var runElapsedMs = 0;
    var lastRunTime = -1;

    // Simulation steps that produced the layout currently on screen — the
    // layout's own clock, and the one worth comparing across sessions.
    // Deliberately maintained beside runElapsedMs, in exactly the places that
    // maintain it, so it inherits its rules rather than restating them: it
    // advances only while stepping, freezes on pause, and keeps counting
    // through a forced run.
    //
    // It returns in restart() not to zero but to baseFrameCount below, which
    // is zero for a graph starting from the circle and the cached step count
    // for one restored from a layout ([D API.7]): steps performed elsewhere
    // are still steps this layout cost.
    var frameCount = 0;
    // Steps already invested in the layout restart() replays back *to* — the
    // graph's starting point, whatever it is. Zero for a circle; for a graph
    // whose data carried a complete layout ([D Data.3]) it is that layout's
    // own step count, taken from data.maxFrames ([F Data.4]).
    //
    // Not simply bestFrameCount: the mark climbs as forced runs beat it, and
    // Reset does not return to where the best run *ended*, it returns to the
    // bootstrap positions. Seeding from the mark would credit the restored
    // layout with steps that produced a layout no longer on screen.
    var baseFrameCount = 0;
    // data.maxFrames as it arrived with the graph currently loaded, sanitized
    // once ([F Data.4]). Held here because two different things read it — the
    // record onSettle compares against, and baseFrameCount above — and
    // reading it twice would also double the warning an invalid value earns.
    var dataMaxFrames = 0;
    // Steps performed since the current layout was (re)built — what the
    // convergence cap spends and the progress bar draws. Split from
    // frameCount so that the cap stays a budget for *this* run: a graph
    // restored from a cache opens frameCount high, and a cap reading it would
    // hand each cache generation a smaller allowance than the last until the
    // run could not take a single step ([F Phys.4]).
    var runFrameCount = 0;
    // The high-water mark across every run of this graph, seeded from
    // data.maxFrames at load() ([F Data.4]) and carried across restarts. It
    // is the *other* half of onSettle's answer: on its own, a step count says
    // nothing about whether this run got further than the last one.
    var bestFrameCount = 0;

    // Identity hash of the current uid set, for onSettle's caching payload
    // ([Opn 3]). Computed once, lazily, at the first convergence a run of
    // this graph reaches — not eagerly in rebuildState(), since a graph that
    // is only ever played with and reset would pay the hashing cost for
    // nothing — then reused for every later onSettle of the same graph
    // (organic settle, then forceContinue()'s forced_settled, both describe
    // the same uid set). null means "not computed yet"; reset to null
    // wherever the uid set can change.
    var graphHash = null;

    applyChrome();

    grid.build(world.state);
    grid3.build(world.state.globe, world.state.count);

    // Timestamps of the frame settled state last flipped, so the renderer can
    // ease the outer fill/perimeter across the transition instead of cutting
    // to it (style.settledTransitionDuration) in either direction: settledAt
    // for entering convergence, unsettledAt for leaving it (a fresh
    // generate/restart/load while settled). -1 = not currently transitioning.
    // Tracked here rather than in the engine because it is about *drawing*
    // the transition, not about the physics itself.
    var settledAt = -1;
    var unsettledAt = -1;
    var wasSettled = false;

    // Which limit ended the run, if one did: 'capped' for the step budget,
    // 'timeout' for the seconds budget, null for a layout that stopped on its
    // own ([F API.6]'s `reason`). Two values rather than one because they are
    // different verdicts on the result — a capped run did all the work asked
    // of it, a timed-out one did as much as the machine managed — and only
    // the host can decide what to do about that ([D Phys.3]). Cleared on a
    // fresh layout, in restart(), alongside the step count it is a statement
    // about.
    var stopReason = null;

    // Fired on every convergence, ordinary and forced alike ([F API.6]) —
    // both are genuinely convergences, and the payload's `state` is what
    // tells them apart. `maxFrames` is the high-water mark of the runs
    // *before* this one, so `frames > maxFrames` reads exactly as "this
    // layout is further along than anything cached for this graph"; the mark
    // is raised afterwards, never before, or that comparison could never come
    // out true. It is raised whether or not anyone is listening, since it is
    // instance state that getStats() also reports, not a by-product of the
    // callback.
    //
    // Both counts being cumulative is what closes the caching loop ([Opn 3]):
    // a forced run on a restored layout reports the cached count plus what it
    // just added, so it beats the record it started from and the host has a
    // correct reason to re-cache. Reported against runFrameCount it would
    // report the increment alone, lose to its own starting point, and tell
    // the host to discard a layout strictly better than the stored one.
    function notifySettled() {
      if (graphHash === null) graphHash = hashUids(world.state.uids);
      var payload = {
        frames: frameCount,
        maxFrames: bestFrameCount,
        state: state,
        reason: stopReason || 'converged',
        hash: graphHash
      };
      // Raised by any run that got further, capped ones included ([D API.8]):
      // the mark is the high-water mark of steps *performed*, which is what
      // its name says and what a capped run has genuinely done — its layout is
      // unfinished, not absent. Whether that number represents a result worth
      // keeping is a separate question, and `reason` above is what answers it.
      if (frameCount > bestFrameCount) bestFrameCount = frameCount;
      if (!settleHandler) return;
      log('cb', 'onSettle', payload);
      // A throwing handler is a bug in host code, but it must not take the
      // frame loop down with it — this is called from inside tick().
      try {
        settleHandler(payload);
      } catch (err) {
        console.warn('[Nodino] onSettle threw', err);
      }
    }

    // Fired on every pause, with the same payload shape onSettle gets
    // ([F API.9]) — a paused layout is a real result, worth exactly the steps
    // that produced it, and a host caching converged layouts ([Opn 3]) has no
    // reason to refuse one just because the run is not over. `reason` is
    // 'paused', which is what distinguishes it from the three endings: this
    // run has not ended, it is waiting.
    //
    // Two deliberate differences from notifySettled(). The high-water mark is
    // *not* raised: pausing is mid-run, and [F API.7] is explicit that a run
    // still going does not overwrite a record it has not finished beating —
    // so `frames > maxFrames` still reads here as "on course to beat it".
    // And nothing is computed at all without a handler, the hash included:
    // unlike the mark, none of this payload is instance state anyone else
    // reads.
    function notifyPaused() {
      if (!pauseHandler) return;
      if (graphHash === null) graphHash = hashUids(world.state.uids);
      var payload = {
        frames: frameCount,
        maxFrames: bestFrameCount,
        state: state,
        reason: 'paused',
        hash: graphHash
      };
      log('cb', 'onPause', payload);
      try {
        pauseHandler(payload);
      } catch (err) {
        console.warn('[Nodino] onPause threw', err);
      }
    }

    // Everything a frame does except paint: the physics step, the two
    // engine-driven transitions, and the chrome that tracks them. Split out
    // from frame() because it has a second driver — while the page is hidden
    // there are no rAF callbacks, and this still has to run ([D Phys.4]).
    // Painting deliberately stays behind in frame(): there is nothing to
    // paint to when nobody is looking, and needsRedraw carries the pending
    // work over to the first visible frame on its own.
    function tick() {
      if (destroyed) return;
      var forcedMode = state === 'forced';
      var maxFrames = config.physics.maxConvergenceFrames;
      var maxMs = config.physics.maxConvergenceSeconds * 1000;
      // Both budgets ([F Phys.4]) apply to a plain run only: entering 'forced'
      // waives them outright, and no other state is stepping at all.
      var capApplies = state === 'running';

      if (isRunningState()) {
        var now = performance.now();
        if (lastRunTime >= 0) runElapsedMs += now - lastRunTime;
        lastRunTime = now;

        // Whichever budget runs out first ends the run, and says so through
        // `reason`. Steps are tested first so that a run reaching exactly the
        // step budget reports 'capped' on every machine: that ending is the
        // reproducible one, and a tie handed to the clock instead would make
        // the verdict itself framerate-dependent.
        //
        // Both are tested before the step, so a run stopped by the step
        // budget performs exactly maxFrames of them rather than "however many
        // fit in the budget here". Against runFrameCount and runElapsedMs —
        // this run's own allowances — not against frameCount, whose steps a
        // previous run banked into a cached layout ([D API.7]).
        var outOfSteps = capApplies && maxFrames > 0 && runFrameCount >= maxFrames;
        var outOfTime = capApplies && maxMs > 0 && runElapsedMs >= maxMs;
        if (outOfSteps || outOfTime) {
          // Both, or the budget would end one layout and leave the other
          // stepping forever behind a state that says the run is over.
          engine.forceSettle();
          globeEngine.forceSettle();
          stopReason = outOfSteps ? 'capped' : 'timeout';
          log('auto', 'convergence budget spent: ' + stopReason, {
            steps: runFrameCount, ms: Math.round(runElapsedMs)
          });
        } else {
          buildGrids();
          // Both layouts advance on the same step, so switching geometry mid-
          // run never shows one that is behind the other ([D Globe.6]). Each
          // engine no-ops once it has settled, so the cheaper of the two stops
          // costing anything as soon as it is done.
          var movedPlane = engine.step(forcedMode);
          var movedGlobe = globeEngine.step(forcedMode);
          if (movedPlane || movedGlobe) needsRedraw = true;
          // Counted here rather than at the draw below, and unconditionally
          // rather than on step()'s return: this branch *is* one simulation
          // step, whereas a draw is skipped whenever nothing moved enough to
          // need one. It is the step count that the layout is a function of.
          frameCount++;
          runFrameCount++;
        }
        // The two engine-driven transitions. Which convergence we just reached
        // depends on which regime produced it: a forced run has no second act
        // ('forced_settled' is terminal), an ordinary one can still be forced.
        if (bothSettled()) setState(forcedMode ? 'forced_settled' : 'settled');
      } else {
        lastRunTime = -1;
      }
      var settled = isSettledState();
      if (settled && !wasSettled) {
        settledAt = performance.now();
        unsettledAt = -1;
        // UX: once the layout stops moving, "what does this look like?" is
        // the natural next question — switch the view straight to it instead
        // of leaving the user staring at the raw force graph. Through
        // setViewMode, so a host that hid the toggle keeps its own mode.
        setViewMode('proximity');
        notifySettled();
      }
      if (!settled && wasSettled) { unsettledAt = performance.now(); settledAt = -1; }
      wasSettled = settled;

      // Keep redrawing for the duration of either transition even though the
      // engine itself may have stopped stepping — a fixed, one-time cost per
      // convergence event (entered or left), not a new continuous redraw
      // source.
      var transitionDuration = config.style.settledTransitionDuration;
      if ((settledAt >= 0 && (performance.now() - settledAt) < transitionDuration) ||
          (unsettledAt >= 0 && (performance.now() - unsettledAt) < transitionDuration)) {
        needsRedraw = true;
      }

      // Shown exactly in the two states a convergence deadline is actually
      // counting down towards something: 'running' and 'running_paused'.
      // Everywhere else there is nothing to show — 'loaded' has not started,
      // 'settled' has arrived, and the three forced states waived both
      // budgets. In 'running_paused' it stays visible but frozen (same
      // treatment as the perimeter, [D Render.2]): neither counter advances
      // while stepping is suspended, so the bar holds its position rather
      // than hiding and having to "catch up" on resume. It tracks the same
      // counters the budgets spend, so it always opens empty — a restored
      // layout gets the whole allowance, and the bar reads as progress
      // through this run rather than through the graph's entire history.
      //
      // With both budgets set the bar shows whichever is further along, since
      // that is the one about to end the run: a bar that tracked only one of
      // them would sit half-full at the moment the other stopped everything.
      // The consequence is that which budget it is showing can change mid-run
      // — the clock overtaking the steps on a slow machine, say — but the
      // quantity it means never does: how close this run is to being cut off.
      var frameProgress = maxFrames > 0 ? runFrameCount / maxFrames : 0;
      var timeProgress = maxMs > 0 ? runElapsedMs / maxMs : 0;
      // The flag itself is no longer tested here: applyChrome() builds this
      // component exactly when the flag asks for it, so its existence *is*
      // the flag ([D Config.3]), and what is left to decide is only whether
      // there is a deadline to show.
      if (progressBar) {
        progressBar.update(
          Math.max(frameProgress, timeProgress),
          (maxFrames > 0 || maxMs > 0) &&
            (state === 'running' || state === 'running_paused')
        );
      }

      // Unconditional, unlike the progress bar: this is a plain elapsed-time
      // display with nothing to hide once a run ends, and it stops advancing
      // on its own the moment runElapsedMs does. The readout drops writes
      // that would not change the text, so calling it every frame is cheap.
      if (timeReadout) timeReadout.update(runElapsedMs, frameCount);
      drawStatus.settled = settled;
    }

    // Filled by tick(), read by frame() — one object reused rather than a
    // fresh literal per frame, this being the hottest allocation site left in
    // the loop.
    var drawStatus = {
      settled: false, settledAt: -1, unsettledAt: -1,
      hasStarted: false, runElapsedMs: 0
    };

    function frame() {
      if (destroyed) return;
      // While the background ticker owns the simulation the rAF loop only
      // keeps itself alive: stepping twice per frame during the overlap
      // between a visibility change and this callback would double the rate
      // and, worse, make the step count depend on how the two interleave.
      if (!backgroundTicker) {
        tick();
        if (needsRedraw) {
          drawStatus.settledAt = settledAt;
          drawStatus.unsettledAt = unsettledAt;
          drawStatus.hasStarted = hasStartedState();
          drawStatus.runElapsedMs = runElapsedMs;
          renderer.draw(drawStatus);
          needsRedraw = false;
          // After the draw, not before: the panel follows where the node was
          // just painted, so the two never disagree by a frame ([F Interact.3]).
          followPin();
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    // Exactly one driver steps the simulation at any moment: the rAF loop
    // while the page is visible, the background ticker while it is not.
    // Re-evaluated on every visibility change and on every state transition,
    // so a run that converges while hidden shuts its own ticker down — no
    // worker is left posting to an instance with nothing to do.
    var backgroundTicker = null;

    function syncDriver() {
      var wantBackground = !destroyed && isHidden() && isRunningState();
      if (wantBackground === !!backgroundTicker) return;
      if (wantBackground) {
        backgroundTicker = createBackgroundTicker(tick);
      } else {
        backgroundTicker.stop();
        backgroundTicker = null;
      }
    }

    function isHidden() {
      return document.hidden === true;
    }

    document.addEventListener('visibilitychange', syncDriver);

    // The grid cell tracks the crowding radius, which depends on node count —
    // so it has to be recomputed whenever the data or the spacing factor change.
    function syncGridCell() {
      grid.cellSize = repulsionRadiusFor(world.state.count, config.physics);
      grid3.cellSize = repulsionRadiusForGlobe(world.state.count, config.physics);
    }

    // Both indices, wherever the plane's alone used to be rebuilt: a stale
    // 3-D index is the same bug as a stale 2-D one, and it shows up in the
    // same place — hover finding nothing on a settled graph.
    function buildGrids() {
      grid.build(world.state);
      grid3.build(world.state.globe, world.state.count);
    }

    // Replays the layout from its initial state with the current data and
    // config — the way to see changed physics parameters take effect from the
    // start. Deterministic ([F Det.1]), so the same config always replays the
    // same run.
    //
    // Deliberately leaves the camera where the user put it ([D Interact.2]):
    // pan and zoom are how someone is *looking* at the graph, not part of the
    // layout being replayed, and having zoomed into a region is the usual
    // reason to want the run again. rebase(), not fitView() — the reference
    // zoom still has to follow the world's extent, the view does not.
    function restart() {
      var radius = layoutInitial(world.state);
      layoutInitialGlobe(world.state);
      world.perimeterRadius = radius;
      renderer.rebase(radius);
      engine.reset();
      globeEngine.reset();
      // A fresh layout gets a fresh convergence-deadline budget: runFrameCount
      // starts the replayed run at step one, so the cap and the progress bar
      // are about to measure this run and nothing else.
      //
      // frameCount instead returns to what the layout being replayed back to
      // already cost — zero for the circle, the cached count for a restored
      // layout ([D API.7]) — because that layout is what is on screen the
      // instant this returns. bestFrameCount deliberately survives both: it is
      // the record across runs of this graph, and a replay is another one of
      // those.
      runElapsedMs = 0;
      lastRunTime = -1;
      frameCount = baseFrameCount;
      runFrameCount = 0;
      stopReason = null;
      // The output readings describe positions this replay has just thrown
      // away ([D View.5]). Dropped rather than recomputed here: restart()
      // lands stopped, and setState() rebuilds whatever the reading on screen
      // needs on the way into that stopped state ([D View.4]).
      //
      // This comment used to name updateConfig() as what would rebuild it,
      // and that was the bug: updateConfig() only runs if a config field
      // actually changed, which on a load() into the mode already selected it
      // does not.
      world.view = null;
      syncGridCell();
      buildGrids();
      // A pin is released here rather than followed through the replay: it
      // points at a node by index, and the internal rebuild this also serves
      // can hand those indices to a different node set entirely ([F Data.2]).
      // The hover goes with it, for the same reason.
      clearHover();
      unpin();
      needsRedraw = true;
    }

    // Rebuilds the graph state from raw input and replays the initial layout —
    // shared by load() (external data change) and the internal maxEdgesPerNode
    // reload (config change). It touches no lifecycle state itself; the two
    // callers set that around it, and they differ only in what they set it to.
    function rebuildState(data) {
      data = data || {};
      world.rawData = data;
      world.state = buildGraphState(
        data.nodes, data.edges, data.positions, config.maxEdgesPerNode,
        data.globePositions
      );
      // What the layout this graph starts from already cost, and therefore
      // where frameCount begins and returns to. Resolved here rather than in
      // load() because coverage is the test ([D Data.3]) and only the built
      // state knows it: a partial bootstrap is a seed, not a result, so its
      // data.maxFrames describes runs that produced no part of these
      // coordinates and must not be credited to them.
      //
      // Reads the already-sanitized dataMaxFrames rather than the raw field:
      // load() sanitizes it once per dataset, whereas this runs again on
      // every maxEdgesPerNode rebuild, and re-reading here would repeat the
      // "invalid maxFrames" warning on every drag of that field.
      baseFrameCount = isCompleteLayout(world.state) ? dataMaxFrames : 0;
      // The uid set just changed (or was rebuilt from the same data, on a
      // maxEdgesPerNode tweak — either way the memo below is no longer
      // trustworthy without re-checking it, and re-hashing an unchanged set
      // costs one pass over a string, not worth branching around).
      graphHash = null;
      restart();
      syncStatsReadout();
      // Same reason, one level up: the query in the search box was asked of
      // the uid set that has just been replaced, and restart() above has
      // already released the pin its last preview placed ([F Interact.3]).
      if (searchBar) searchBar.sync();
    }

    // Mirror of the settled -> 'proximity' switch in tick(): a graph that is
    // (re)loaded and about to start is raw data again, not a result to admire
    // yet — 'relations', the mode that shows what actually drives the layout, is
    // the useful default until it settles once more.
    // No-op when the toggle is hidden. The automatic switching and the toggle
    // are one feature, not two: the rule moves the reading between 'relations'
    // and 'proximity' as the graph starts and stops, and the toggle is what
    // lets a viewer disagree with it. With the control gone, changing the
    // mode underneath the host would change what the graph means with nothing
    // on screen able to change it back — the same trap showDebugToggle avoids
    // by gating the panel and not just its button ([D Config.5]). A host that
    // hides the toggle therefore owns config.viewMode outright, and can still
    // set it whenever it likes through updateConfig().
    function setViewMode(mode) {
      if (!config.showViewModeToggle) return;
      if (config.viewMode === mode) return;
      // Logged before the updateConfig() it performs, so the trace reads as
      // "the widget decided, then applied it" — otherwise an automatic switch
      // is indistinguishable from a host call.
      log('auto', 'view mode -> ' + mode);
      updateConfig({ viewMode: mode });
    }

    function resetViewModeToRelations() {
      setViewMode('relations');
    }

    // Computes whatever the current view needs and has not got, from the
    // positions as they stand. Called when the view or one of its parameters
    // changes — never from the frame loop, which is what makes an O(n + P)
    // reading affordable at all: the views are offered only while the
    // simulation is stopped ([D View.2]), so what they describe cannot move
    // underneath them, and one computation serves every frame until it does.
    //
    // Each piece is filled in separately, so switching Proximity -> Clusters
    // reuses the radius neighbourhood both of them are built on instead of
    // repeating it, and raising the cluster cut does not recompute it.
    function ensureView() {
      var mode = config.viewMode;
      if (mode === 'relations' || world.state.count === 0) return;
      if (!world.view) world.view = {};
      var view = world.view;
      // Same reading, same radius, the metric of whichever geometry is on
      // screen ([D Globe.3]). The two graphs are genuinely different — the
      // sphere puts different pairs within the radius — so the cache belongs
      // to one geometry at a time and switching drops it ([D Globe.6]).
      if (!view.proximity) {
        view.proximity = config.geometry === 'globe'
          ? computeProximityGlobe(world.state, config.globeProximityMaxDistance)
          : computeProximity(world.state, config.proximityMaxDistance);
        log('auto', 'proximity computed', {
          geometry: config.geometry,
          nodes: world.state.count, edges: view.proximity.count
        });
      }
      if (mode === 'clusters' && !view.clusters) {
        view.clusters = computeClusters(
          view.proximity, world.state.count,
          config.clusterQuantile, config.style.clusterMinSize
        );
        log('auto', 'clusters computed', {
          components: view.clusters.sizes.length,
          cutAt: view.clusters.threshold
        });
      }
      needsRedraw = true;
    }

    // Where a (re)built graph lands: 'empty' with no nodes to run, 'settled'
    // when the data carried a complete layout rather than a graph to lay out
    // ([D Data.3]), 'loaded' otherwise. Shared by load() and the internal
    // maxEdgesPerNode rebuild, which must not resurrect a runnable state out
    // of no nodes.
    function stateAfterRebuild() {
      if (world.state.count === 0) return 'empty';
      return isCompleteLayout(world.state) ? 'settled' : 'loaded';
    }

    // Bookkeeping for landing in 'settled' without having run: the engine is
    // told to agree (there is nothing to step), and tick()'s convergence edge
    // is pre-armed so it does not fire onSettle for a run that never happened
    // — `reason` would be a verdict on nothing, and the restored `frames`
    // would be re-reported as an achievement of this instance. settledAt = -1
    // leaves draw() past the end of its easing, so the perimeter shows the
    // settled look outright instead of animating a convergence this instance
    // did not perform.
    function settleRebuilt() {
      engine.forceSettle();
      // The sphere is settled only if the payload actually carried one
      // ([D Globe.9]). A host that cached both gets both finished; one that
      // cached only the plane leaves the globe engine live, so the sphere is
      // laid out by the next run instead of being frozen at its spiral and
      // presented as a result. The plane, already converged, settles again
      // almost immediately — restoring it is not wasted.
      if (isCompleteGlobeLayout(world.state)) globeEngine.forceSettle();
      wasSettled = true;
      settledAt = -1;
      unsettledAt = -1;
    }

    // Sole data-ingestion entry point (replaces any previous graph).
    // `data.edges` is mandatory ([sourceUid, targetUid, weight] tuples);
    // `data.nodes` (uid -> { m }), `data.positions` (uid -> { x, y }
    // bootstrap), `data.globePositions` (uid -> { x, y, z }, the sphere's own
    // and entirely independent of the plane's, [D Globe.9]) and
    // `data.maxFrames` are optional — see NodinoLoadData.
    // Never starts the simulation: the freshly loaded layout is drawn at rest,
    // and running it is a separate, explicit start().
    //
    // load() is legal from every state but 'destroyed' — 'empty' and 'loaded'
    // included, since the data itself changes. It always lands on a
    // (re)built graph sitting at its initial layout with a fresh step budget,
    // whatever was happening a moment ago. setState comes last on purpose: an
    // onStateChange listener that reads getStats() from inside the callback
    // must see the graph it is being told about, not the one being replaced.
    //
    // `options` carries the things that belong to a *dataset* rather than to
    // the instance ([D API.2]):
    //   onNodeHover - what a node's hovering card should show *below* the uid
    //                 title, which is a question about this data's metadata
    //                 shape.
    //   onNodePin   - the same for the card a click pins ([D API.11]), the one
    //                 that can hold controls because it takes the mouse.
    //                 Defaults to onNodeHover.
    //   onSettle    - what to do with a converged layout of *this* graph,
    //                 whose companion input (data.maxFrames) travels with the
    //                 data in the same call.
    //   config      - a partial config patch, for parameters tuned to this
    //                 dataset (a denser graph wanting a different
    //                 maxEdgesPerNode, say).
    // The callbacks are replaced wholesale per load rather than accumulated:
    // omitting onNodeHover means this dataset has nothing to add to the cards'
    // default title, and omitting onSettle means nothing is listening for this
    // one's convergence — not that the previous dataset's handlers carry over.
    // `config`, being a patch onto the live config, does persist — same
    // semantics as updateConfig().
    // Named loadOptions, not options: `options` is create()'s argument and is
    // still in scope here, so reusing the name would shadow it silently.
    function load(data, loadOptions) {
      log('api', 'load()', {
        nodes: data && data.nodes ? Object.keys(data.nodes).length : 0,
        edges: data && data.edges ? data.edges.length : 0,
        positions: data && data.positions ? Object.keys(data.positions).length : 0,
        maxFrames: data && data.maxFrames
      });
      if (state === 'destroyed') return refuse('load');
      loadOptions = loadOptions || {};
      hoverHandler = typeof loadOptions.onNodeHover === 'function' ? loadOptions.onNodeHover : null;
      // Falls back to the hover handler rather than to nothing ([D API.11]):
      // a dataset that says what a node is worth showing has said it for both
      // cards, and clicking a node must never yield *less* than pointing at
      // it. Supplying both is how a host adds what only works when clickable.
      pinHandler = typeof loadOptions.onNodePin === 'function' ? loadOptions.onNodePin : hoverHandler;
      settleHandler = typeof loadOptions.onSettle === 'function' ? loadOptions.onSettle : null;
      pauseHandler = typeof loadOptions.onPause === 'function' ? loadOptions.onPause : null;
      if (loadOptions.config) {
        // Merged directly rather than through updateConfig(), which would
        // rebuild the graph from the *old* data on a maxEdgesPerNode change,
        // moments before rebuildState() below rebuilds it from the new. The
        // chrome still has to be reconciled, since the patch may carry show*
        // flags ([D Config.3]).
        deepMerge(config, loadOptions.config);
        applyChrome();
        if (viewModeToggle) viewModeToggle.sync(isStoppedState());
        if (debugToggle) debugToggle.sync();
      }
      // Sanitized here, once per dataset, before the rebuild that reads it:
      // this is the one call that brings a new value in, and warning about a
      // bad one belongs to the moment it arrives rather than to every later
      // rebuild of the same graph ([F Data.4]).
      dataMaxFrames = readMaxFrames(data);
      // The camera is not touched here either ([D Interact.2]): rebuildState()
      // rebases the reference zoom through restart(), and where the user was
      // looking survives the new data as it survives everything else.
      rebuildState(data);
      // The record travels with the data ([F Data.4]): a host restoring a
      // graph hands back the best step count it has stored for it, and the
      // first onSettle of this session can already say whether the new run
      // beat it. Absent means "no history" — which is also why it is taken
      // from the incoming data and not carried over from the outgoing
      // dataset, whose record belonged to a different graph. Read from the
      // value rebuildState() already sanitized rather than from data again,
      // the two being the same field read for two purposes.
      bestFrameCount = dataMaxFrames;
      // Decided after the rebuild, not before: whether this data is a graph to
      // lay out or a layout already laid out is a property of the data, and
      // only buildGraphState knows it. A restored layout opens the way a
      // converged one is left — 'proximity', the reading, rather than
      // 'relations', the machinery ([D View.1]).
      var next = stateAfterRebuild();
      if (next === 'settled') settleRebuilt();
      setViewMode(next === 'settled' ? 'proximity' : 'relations');
      // Forced, so that a load() landing back on the state it started from
      // still reports itself: `loaded -> loaded` and `empty -> empty` are
      // transitions of the data, and the only ones a host cannot infer from
      // the state name it is handed.
      setState(next, true);
    }

    // Public restart(): same "at rest until explicit start()" contract as
    // load() — replaying from the initial layout is itself a kind of (re)load.
    // Refused in 'loaded', where there is nothing to replay back to (see
    // TRANSITIONS). Distinct from the bare restart() above, which the
    // maxEdgesPerNode reload also goes through and which deliberately leaves
    // the state alone, so a graph playing while you tweak the debug panel
    // keeps playing instead of dropping out of its run mid-tweak.
    function restartAndStop() {
      log('api', 'restart()');
      applyTransition('restart', function () {
        resetViewModeToRelations();
        restart();
      });
    }

    // The three host-driven verbs. Each is a pure state transition: the work
    // of *entering* the state is either nil (start/pause — tick() reads the
    // state each tick) or one engine call (forceContinue). Refused calls warn
    // and change nothing — see TRANSITIONS.
    //
    // start() no longer touches runElapsedMs at all. It used to reset the
    // budget whenever it cleared the force waiver, which is precisely how
    // resuming from 'forced_paused' re-armed a cap that had been waived for
    // good; the budget is now reset in exactly one place — restart(), where a
    // genuinely fresh layout begins.
    // The reading is reset to 'relations' on the way into motion, but not
    // here: setState() does it for every path into a running state at once
    // ([D View.4]).
    function start() {
      log('api', 'start()');
      if (applyTransition('start')) needsRedraw = true;
    }

    function pause() {
      log('api', 'pause()');
      // The payload is a genuine offer, so it is made after the transition
      // has landed: `state` in it is the paused state, not the one being
      // left ([F API.9]).
      if (applyTransition('pause')) notifyPaused();
    }

    // Resumes stepping past a convergence already reached, without replaying
    // the layout from scratch (unlike restart()): epsilon, positions and
    // velocities are left exactly where they were, only the settled flag is
    // cleared. Legal from 'settled' only. Entering 'forced' waives both
    // convergence budgets outright — after being forced past one convergence
    // the layout gets to find a natural one instead of tripping the same
    // limit a frame later — and switches the stop threshold to the
    // stricter physics.forcedStopVelocity, without which it would simply
    // re-settle within stopFrames.
    function forceContinue() {
      log('api', 'forceContinue()');
      // Only the 'settled' entry has a convergence to clear. Resuming from
      // 'forced_paused' must *not* call forceUnsettle(): the engine was never
      // settled there, and the call would reset stableFrames — throwing away
      // progress the paused run had already made towards its forced
      // convergence, which is not what pausing and resuming should cost.
      var onEnter = state === 'settled' ? function () {
        engine.forceUnsettle();
        globeEngine.forceUnsettle();
      } : null;
      if (!applyTransition('forceContinue', onEnter)) return;
      // A forced run waives both budgets, so it can only ever end on a genuine
      // convergence. Without clearing this, a run that had been stopped by one
      // of them would hand its own verdict to the forced run that followed it,
      // reporting 'capped'/'timeout' for a convergence nothing cut short.
      stopReason = null;
      // The reading went back to 'relations' in setState(), 'forced' being a
      // running state ([D View.4]); the switch back to an output reading
      // happens where it always does, on reaching convergence (tick()) —
      // which for a forced run is 'forced_settled'.
      needsRedraw = true;
    }

    function updateConfig(partial) {
      log('api', 'updateConfig()', partial);
      // Not a lifecycle transition, but it has to respect the terminal state
      // all the same: applyChrome() below would happily build fresh chrome
      // into a container this instance has already let go of.
      if (state === 'destroyed') return refuse('updateConfig');
      // A bare updateConfig() used to reach the property tests below on
      // `undefined` and throw. Nothing to merge is a legitimate no-op, not an
      // error.
      partial = partial || {};
      deepMerge(config, partial);

      // Independent tests, not a chain: as an `else if` ladder a patch
      // carrying two of these applied only the first, so
      // `{ maxEdgesPerNode, physics: { repulsionSpacing } }` silently skipped
      // the grid resync. `rebuilt` is the one genuine exclusion — the rebuild
      // already reapplies both of the others from the live config.
      var rebuilt = false;

      if (partial.maxEdgesPerNode !== undefined) {
        // Changes which edges exist, so the graph has to be rebuilt from the
        // original input — this restarts the layout, as a data change would.
        // Unlike load(), this is a config tweak, not a fresh data ingestion,
        // so a graph playing while you drag the Max Edges/Node slider keeps
        // playing. Everything else lands on 'loaded', matching what the
        // replayed initial layout now shows. A 'forced' run collapses to a
        // plain 'running' one: the waiver it carried belonged to the
        // convergence this rebuild just threw away.
        rebuildState(world.rawData);
        rebuilt = true;
        var next = isRunningState() ? 'running' : stateAfterRebuild();
        if (next === 'settled') settleRebuilt();
        // The rebuild threw the old layout away, so the view mode has to
        // follow the same rule every other (re)build follows ([D View.1]):
        // the reading for a graph that opens converged, the machinery for one
        // that is raw data again. Without this the mode stayed on 'proximity'
        // from the convergence being discarded while sync() below removed the
        // Proximity button for being unsettled — an output reading over a graph
        // in 'loaded', with nothing on screen naming the mode in force and
        // only the Relations button to escape it.
        //
        // Assigned rather than routed through setViewMode(), which would
        // re-enter updateConfig(): the syncs at the end of this call are
        // exactly what that re-entry would have triggered.
        if (config.showViewModeToggle) {
          config.viewMode = next === 'settled' ? 'proximity' : 'relations';
        }
        setState(next);
      }

      // Parameters of the output readings ([D View.5], [D View.6]). Each
      // invalidates only what it actually changes, so raising the cluster cut
      // does not throw away the radius neighbourhood both readings share. Independent
      // tests for the same reason the branches above are.
      if (world.view) {
        // The radius is what the reading *is* ([D View.9]), not a filter over
        // it, so changing it rebuilds rather than repaints — the one knob in
        // the Proximity group that costs O(n + P).
        if (partial.proximityMaxDistance !== undefined ||
            partial.globeProximityMaxDistance !== undefined) world.view = null;
        // And the geometry decides *which* pairs the same radius admits, so a
        // cached reading belongs to the geometry that produced it. Cheap to
        // drop: the readings are only ever offered while stopped, so this is
        // one O(n + P) rebuild, not a per-frame cost ([D Globe.6]).
        if (partial.geometry !== undefined) world.view = null;
        if (partial.clusterQuantile !== undefined && world.view) world.view.clusters = null;
        if (partial.style && world.view) {
          // Nothing under style invalidates the proximity graph: colour,
          // alpha and both widths are read at draw time, so they cost a
          // repaint and not a recompute ([D View.11]).
          if (partial.style.clusterMinSize !== undefined) world.view.clusters = null;
        }
      }

      if (!rebuilt && partial.physics && partial.physics.repulsionSpacing !== undefined) {
        syncGridCell();
        // Rebuilt, not just resized. The cell size is read live by the grid's
        // own indexing while its CSR arrays still describe the old one, so
        // between the two the index is incoherent — and outside a run nothing
        // ever rebuilds it, since tick() only does so while stepping. A
        // smaller cell pushes every computed index past the old extent and
        // hover hit-testing stops finding anything at all, on a settled graph,
        // until the next Run or Reset.
        buildGrids();
      }

      // Build/tear down whatever the show* flags now ask for, then let the
      // survivors refresh their own active/inactive rendering.
      applyChrome();
      if (viewModeToggle) viewModeToggle.sync(isStoppedState());
      if (geometryToggle) geometryToggle.sync();
      if (debugToggle) debugToggle.sync();
      // The panel binds its inputs to config once, at construction, so any
      // change arriving from elsewhere — the host's own updateConfig(), the
      // Attraction/Repulsion lock, the automatic view-mode switch — has to be
      // read back into the fields or they go on showing values no longer in
      // force.
      if (debugPanel) debugPanel.syncValues();
      // Last, so it sees the config this call just installed — including a
      // viewMode change, which is the ordinary way an output reading is
      // asked for in the first place.
      ensureView();
      needsRedraw = true;
    }

    // Terminal transition, legal from every state except itself. Tearing the
    // chrome down first and nulling the references means setState() below
    // reaches only what still exists; after it, every verb — load() included
    // — is refused, so a stale reference to a destroyed instance can no
    // longer silently mutate state behind a frame loop that has already
    // stopped.
    function destroy() {
      log('api', 'destroy()');
      if (state === 'destroyed') return refuse('destroy');
      destroyed = true;
      resizeObserver.disconnect();
      // The two listeners this instance puts outside its own container, and
      // the one worker it may own: all would otherwise outlive it, the
      // ticker still stepping a destroyed engine ([D Phys.4]) and the keydown
      // holding this whole closure alive through a released pin.
      document.removeEventListener('visibilitychange', syncDriver);
      document.removeEventListener('keydown', onKeyDown);
      if (backgroundTicker) { backgroundTicker.stop(); backgroundTicker = null; }
      interaction.destroy();
      hoverPanel.destroy();
      pinPanel.destroy();
      if (debugPanel) { debugPanel.destroy(); debugPanel = null; }
      if (viewModeToggle) { viewModeToggle.destroy(); viewModeToggle = null; }
      if (geometryToggle) { geometryToggle.destroy(); geometryToggle = null; }
      if (searchBar) { searchBar.destroy(); searchBar = null; }
      if (debugToggle) { debugToggle.destroy(); debugToggle = null; }
      if (simControls) { simControls.destroy(); simControls = null; }
      if (statsReadout) { statsReadout.destroy(); statsReadout = null; }
      if (timeReadout) { timeReadout.destroy(); timeReadout = null; }
      if (progressBar) { progressBar.destroy(); progressBar = null; }
      container.removeChild(chromeRow);
      container.removeChild(viewRow);
      container.removeChild(canvas);
      // The two inline styles create() set on a container it does not own,
      // returned to whatever the host had there (usually '', which removes
      // them). Nothing of this instance should survive on that element.
      container.style.position = hostPosition;
      container.style.overflow = hostOverflow;
      setState('destroyed');
    }

    return {
      load: load,
      restart: restartAndStop,
      start: start,
      pause: pause,
      forceContinue: forceContinue,
      updateConfig: updateConfig,
      // The two gestures a node answers, by uid: pin a detail card and
      // release it ([F API.10]), hover a node and stop ([F API.11]) — the
      // click, the Esc key and the cursor of [F Interact.2]/[F Interact.3]
      // reachable from host code, named after what they do rather than after
      // the input events that are the other way to reach them.
      //
      // None of the four is governed by the lifecycle table ([F State.1]),
      // for the same reason the getters are not: none is a transition, and a
      // card is legible in every state a graph exists in — a run in progress
      // is exactly when a pin is worth having, since it is the one panel that
      // does not drift from its node ([Rsk Interact.1]). A uid this graph
      // does not have is answered with `false` and a warning, not a refusal,
      // because it is a question about the data rather than about the state.
      //
      // `hover()` is traced like the rest despite the canvas hover not being
      // ([D Config.7]): what that rule keeps out of the log is an event
      // firing at cursor rate, and a host calling this is not one.
      pin: function (uid) {
        log('api', 'pin()', uid);
        return pinByUid(uid);
      },
      unpin: function () {
        log('api', 'unpin()');
        return unpin();
      },
      hover: function (uid) {
        log('api', 'hover()', uid);
        return hoverByUid(uid);
      },
      unhover: function () {
        log('api', 'unhover()');
        return endHover();
      },
      destroy: destroy,
      // The layout as it stands, keyed by uid and shaped exactly like
      // load()'s `positions` ([F API.8]) — the return trip of the only thing
      // Nodino computes that the host does not already have. Without it the
      // caching in [Opn 3] cannot be written at all: a host can be told how
      // many steps a run took and never see what those steps produced.
      //
      // Only the positions, deliberately: nodes, edges and metadata came from
      // the host in the first place, and handing them back would make Nodino
      // the authority on data it merely borrowed. Composing the two into a
      // payload is one object literal at the call site.
      //
      // A fresh object per call, not a live view: these are the working
      // arrays the engine mutates every step, and exposing them would hand
      // the host a snapshot that silently changes under it.
      getPositions: function () {
        var out = {};
        // Named for what it is rather than `state`, which is the lifecycle
        // state in every other closure in this file.
        var graph = world.state;
        for (var i = 0; i < graph.count; i++) {
          out[graph.uids[i]] = { x: graph.x[i], y: graph.y[i] };
        }
        return out;
      },
      // The spherical layout, keyed by uid and shaped exactly like load()'s
      // `globePositions` ([D Globe.9]) — the same return trip as getPositions()
      // makes for the plane.
      //
      // A second method rather than a `z` on the first, and a second field
      // rather than a third coordinate on `positions`: these are two
      // *embeddings*, not one layout with a spare axis. Merging them would
      // imply a relationship between (x, y) and (x, y, z) that does not exist
      // — no projection connects them ([D Globe.8]) — and would silently
      // change the shape of a payload every existing host already stores.
      // Cache both, cache one, cache neither; each is honoured on its own.
      getGlobePositions: function () {
        var out = {};
        var graph = world.state;
        var g = graph.globe;
        for (var i = 0; i < graph.count; i++) {
          out[graph.uids[i]] = { x: g.x[i], y: g.y[i], z: g.z[i] };
        }
        return out;
      },
      // Diagnostic: once settled the frame loop stops stepping and redrawing,
      // so a layout that never settles is a layout that never stops costing.
      // `state` is the lifecycle state ([F State.1]) — the one field a host
      // needs to drive its own controls, since which of start/pause/
      // forceContinue is legal is a function of it alone. `settled` is kept
      // as the coarser "is it done moving" answer (true in both 'settled' and
      // 'forced_settled').
      getStats: function () {
        return {
          state: state,
          settled: isSettledState(),
          nodeCount: world.state.count,
          edgeCount: world.state.edgeCount,
          inputEdgeCount: world.state.inputEdgeCount,
          // The same two numbers onSettle is handed ([F API.6]), for a host
          // that would rather poll than listen, and with the same meanings:
          // `frames` is what the layout on screen has cost so far, `maxFrames`
          // the furthest any run of this graph has already got. The mark
          // deliberately does not absorb `frames` as it climbs — it is raised
          // where every other run's contribution is raised, at the convergence
          // that ends it, so a run still going does not quietly overwrite the
          // record it has not finished beating. Mid-run the two are simply
          // independent, and `frames > maxFrames` reads as "on course to beat
          // it".
          //
          // Polled straight after a load() that restored a layout, `frames`
          // already reads that layout's cached count rather than 0: nothing
          // has run yet, but something ran to produce what is on screen.
          frames: frameCount,
          maxFrames: bestFrameCount
        };
      }
    };
  }

  global.Nodino = { create: create };
})(window);
