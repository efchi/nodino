# Nodino — API Reference

Exhaustive interface reference for `nodino.js` (+ `nodino.css` for its optional chrome). For *why* things work this way, see [`nodino.dox.md`](nodino.dox.md) — this document only covers *what* is exposed and *how* to call it.

- No build step, no dependencies. Two files: `nodino.js` (logic + canvas rendering) and `nodino.css` (optional menu/chrome styling — only needed if any chrome flag below is on).
- Deterministic: the same input (data + config) always produces the same layout, on any machine, on any run. `nodino.js` never calls `Math.random()`.

```html
<link rel="stylesheet" href="nodino.css" />
<div id="graph" style="position: relative; width: 100%; height: 100%;"></div>
<script src="nodino.js"></script>
<script>
  var nodino = Nodino.create(document.getElementById('graph'), { config: { /* ... */ } });
  nodino.load({ edges: [['a', 'b', 0.8], ['a', 'c', -0.4]] });
  nodino.start();
</script>
```

See `demo.html` for a fuller walkthrough — every data source plus the debug/tweak panel.

## Contents

1. [`Nodino.create()`](#nodinocreatecontainer-options)
2. [Instance methods](#instance-methods)
3. [Lifecycle](#lifecycle)
4. [Data shapes](#data-shapes)
5. [Callbacks](#callbacks)
6. [Config reference](#config-reference)
7. [UI features (chrome)](#ui-features-chrome)
8. [Interaction (mouse / touch)](#interaction-mouse--touch)

## `Nodino.create(container, options)`

Creates one graph instance inside `container`. Does **not** load or draw any data — call [`load()`](#loaddata-loadoptions) next.

| Param | Type | Notes |
|---|---|---|
| `container` | `HTMLElement` | Must have a size. `create()` sets `position: relative` on it if its computed position is `static`, and unconditionally sets `overflow: hidden` — both restored to whatever they were before on `destroy()`. Chrome is appended as absolutely-positioned children. |
| `options.config` | `object` | Optional. A partial patch onto [`DEFAULT_CONFIG`](#config-reference) — deep-merged, so `{ style: { nodeColor: '#f00' } }` only overrides that one field. |
| `options.onStateChange` | `(state: NodinoState) => void` | Optional. Fires on every [lifecycle](#lifecycle) transition, including the two the engine makes on its own (reaching convergence). Not called for the initial `'empty'`. The way to mirror lifecycle state into a host's own UI without polling `getStats()`. |

Returns an **instance** — the object documented below. Multiple instances (multiple containers) are fully independent.

```js
var nodino = Nodino.create(el, {
  config: { maxEdgesPerNode: 15, style: { nodeColor: '#1a1a3a' } },
  onStateChange: function (state) { console.log('[nodino]', state); }
});
```

## Instance methods

Every method below is a no-op with a `console.warn` if called on a `'destroyed'` instance. The four lifecycle verbs (`start`/`pause`/`forceContinue`/`restart`) additionally refuse (warn, return `false`, no state change) when the *current* state has no transition for that action — see the [table](#lifecycle). `load()` and `destroy()` are legal in every state but `'destroyed'`.

### `load(data, loadOptions)`

The sole data-ingestion entry point — **replaces any previous graph**. Never starts the simulation: the loaded layout is drawn at rest, and running it is a separate, explicit `start()`. Legal from every state but `'destroyed'`, `'empty'` and `'loaded'` included, since the data itself is what's changing.

| Param | Type | Notes |
|---|---|---|
| `data` | [`NodinoLoadData`](#nodinoloaddata) | Required. `edges` is the only mandatory field. |
| `loadOptions.onNodeHover` | `(node, body) => any` | Optional. See [Callbacks](#callbacks). |
| `loadOptions.onNodePin` | `(node, body) => any` | Optional. Defaults to `onNodeHover` if omitted. |
| `loadOptions.onSettle` | `(result: NodinoResult) => void` | Optional. |
| `loadOptions.onPause` | `(result: NodinoResult) => void` | Optional. |
| `loadOptions.config` | `object` | Optional. A partial config patch scoped to *this* dataset (e.g. a denser graph wanting a different `maxEdgesPerNode`) — same deep-merge semantics as `updateConfig()`, and it persists past this one `load()` call. |

Callbacks are replaced wholesale per `load()`, not accumulated — omitting `onSettle` means nothing is listening for *this* graph's convergence, not that the previous dataset's handler carries over.

```js
nodino.load(
  { edges: [['apple', 'pear', 0.9], ['apple', 'hammer', -0.5]] },
  { onNodeHover: function (node) { return '<b>' + node.uid + '</b>'; } }
);
```

### `start()`

Begins or resumes stepping. Legal from `'loaded'` and `'running_paused'` → `'running'`.

### `pause()`

Suspends stepping without discarding progress. Legal from `'running'` → `'running_paused'` and `'forced'` → `'forced_paused'`.

### `forceContinue()`

Continues stepping **past** a convergence already reached, waiving both convergence budgets (`physics.maxConvergenceSeconds`/`maxConvergenceFrames`) — the only thing that ends a forced run is `physics.forcedStopVelocity`. Legal from `'settled'` and `'forced_paused'` → `'forced'`. (Resuming a paused *forced* run always goes through `forceContinue()`, never `start()` — the two would land in the same place, but which button is enabled says which regime is in force.)

### `restart()`

Replays the current graph from its initial frame — same data, fresh step budget, cleared camera state untouched (pan/zoom/rotation survive, [`nodino.dox.md`](nodino.dox.md) § Interaction). Refused from `'empty'`/`'loaded'` (nothing to replay, or already at frame one). Legal from every running/settled/forced state → `'loaded'`.

### `updateConfig(partial)`

Applies a partial, deep-merged patch to the live config at any time (including while running). Which fields take effect immediately vs. only on the next `restart()`/`load()` depends on the field — tunables affecting the physics step generally apply on the next rebuild; presentational fields (color, alpha, radius…) apply on the next drawn frame. Toggling a chrome flag (`showSearch`, `showDebugToggle`, …) builds or tears down that component immediately.

```js
nodino.updateConfig({ geometry: 'plane', style: { proximityMaxDistance: 0.3 } });
```

### `pin(uid)` / `unpin()`

Pins/releases the detail card to the named node — the same thing a click on the node does ([F Interact.3]). `pin()` on a uid this graph does not have returns `false` with a console warning (a question about the data, not a refusal of the call). Not gated by lifecycle state — a pin is legible in every state a graph exists in.

### `hover(uid)` / `unhover()`

Same pair for the hover card — the same thing the cursor arriving on a node does. Also ungated by lifecycle state.

### `getPositions()`

Returns the current planar layout as `{ [uid]: { x, y } }` — a fresh snapshot object each call (not a live view into the engine's working arrays). Shaped exactly like `load()`'s `data.positions`, which is what makes the round trip (`getPositions()` now, `positions` on the next `load()`) work.

### `getGlobePositions()`

Same as `getPositions()` for the spherical layout: `{ [uid]: { x, y, z } }`, shaped like `data.globePositions`. Independent of `getPositions()` — the two are separate embeddings of the same graph, not one layout with a spare axis; cache one, both, or neither.

### `getStats()`

```ts
{
  state: NodinoState,
  settled: boolean,        // true in both 'settled' and 'forced_settled'
  nodeCount: number,
  edgeCount: number,       // after sparsification (maxEdgesPerNode)
  inputEdgeCount: number,  // before sparsification
  frames: number,          // steps the on-screen layout has cost so far
  maxFrames: number        // best step count any run of this graph has reached
}
```

Polling equivalent of the `frames`/`maxFrames` pair handed to `onSettle`/`onPause` — see [`NodinoResult`](#nodinoresult).

### `destroy()`

Tears down the instance: stops the frame loop, removes every DOM node this instance created, restores the container's own `position`/`overflow` inline styles to what they were before `create()`. Legal in every state but `'destroyed'`; always terminal.

## Lifecycle

```ts
type NodinoState =
  | 'empty' | 'loaded'
  | 'running' | 'running_paused'
  | 'settled'
  | 'forced' | 'forced_paused' | 'forced_settled'
  | 'destroyed'
```

`'empty'` is a `load()` that produced no nodes at all; everything else behaves like `'loaded'` but never has anything to run. The two engine-driven transitions — `'running' → 'settled'` and `'forced' → 'forced_settled'` — happen on their own, on convergence, and still fire `onStateChange`.

| Action | Legal from | Lands on |
|---|---|---|
| `start()` | `loaded`, `running_paused` | `running` |
| `pause()` | `running`, `forced` | `running_paused`, `forced_paused` |
| `forceContinue()` | `settled`, `forced_paused` | `forced` |
| `restart()` | `running`, `running_paused`, `settled`, `forced`, `forced_paused`, `forced_settled` | `loaded` |
| `load(data)` | anything but `destroyed` | `empty`, `loaded`, or `settled` — depends on `data` (see below) |
| `destroy()` | anything but `destroyed` | `destroyed` |

`load()` lands on `'settled'` directly, skipping a run entirely, when `data.positions` covers **every** node — a complete layout is a result, not a seed ([D Data.3] in the dox). A partial or absent `positions` lands on `'loaded'` instead, ready for `start()`.

Any call refused by this table (or reached on a `'destroyed'` instance) is a no-op: `console.warn`, no state change, no exception thrown.

## Data shapes

### `NodinoNodeEntry`

```ts
{ m?: object }  // m = metadata, opaque to Nodino — handed back verbatim to onNodeHover/onNodePin
```

### `NodinoEdgeInput`

```ts
[sourceUid: string, targetUid: string, weight: number]  // weight in [-1, 1]
```

Positive attracts, negative repels, `0` (or no edge) means no relation at all. A node exists as soon as an edge names it — `data.nodes` is only for attaching metadata to it.

### `NodinoPosition`

```ts
{ x: number, y: number }  // in [-1, 1], relative to the unit boundary circle
```

### `NodinoGlobePosition`

```ts
{ x: number, y: number, z: number }  // a vector on the unit sphere — renormalized on the way in
```

Independent of `NodinoPosition`: either, both, or neither may be present in a payload.

### `NodinoLoadData`

```ts
{
  edges: NodinoEdgeInput[],                          // required
  nodes?: { [uid: string]: NodinoNodeEntry },
  positions?: { [uid: string]: NodinoPosition },      // planar bootstrap/result
  globePositions?: { [uid: string]: NodinoGlobePosition }, // spherical bootstrap/result
  maxFrames?: number                                  // best step count a previous run of this graph reached, if the host is caching it
}
```

### `NodinoResult`

Payload of `onSettle` and `onPause` alike.

```ts
{
  frames: number,      // steps this converged/paused layout cost, including any it was restored with
  maxFrames: number,   // best any previous run of this graph reached (seeded from data.maxFrames, raised as runs beat it)
  state: NodinoState,  // 'settled' | 'forced_settled' (onSettle) or the running/forced state paused from, reason: 'paused' either way
  reason: 'converged' | 'capped' | 'timeout' | 'paused',
  hash: string         // identifies the graph's uid *set* — stable across host iteration order, for a server-side cache key
}
```

`reason` says how a run ended: `'converged'` (stopped moving on its own), `'capped'` (`physics.maxConvergenceFrames` cut it short), `'timeout'` (`physics.maxConvergenceSeconds` did), `'paused'` (the user paused mid-run — `onPause` only).

## Callbacks

All callbacks are optional.

| Callback | Set via | Signature |
|---|---|---|
| `onStateChange` | `create()` | `(state: NodinoState) => void` |
| `onNodeHover` | `load()` | `(node: { uid: string, m: object \| null }, body: HTMLElement) => any` |
| `onNodePin` | `load()` | same as `onNodeHover`; defaults to it if omitted |
| `onSettle` | `load()` | `(result: NodinoResult) => void` |
| `onPause` | `load()` | `(result: NodinoResult) => void` |

**`onNodeHover`/`onNodePin`** are handed the node and the detail panel's body element — an empty `<div>` under the uid title, cleared before every call. Three ways to fill it, in order of precedence:

1. Write DOM into `body` directly (listeners included).
2. Return an HTML string — replaces `body`'s contents.
3. Return a `Promise` of one of the above — the slot holds whatever was written synchronously (e.g. a loading spinner) until the promise resolves, then the resolved string replaces it.

Return/write nothing and the title (the uid) stays the only content. `onNodePin`'s card takes the mouse (`pointer-events: auto`) — put buttons and links there, not in `onNodeHover`'s (click-through, since it follows the cursor).

```js
nodino.load(data, {
  onNodeHover: function (node, body) {
    return '<b>' + node.uid + '</b><br>' + (node.m ? node.m.kind : '');
  },
  onNodePin: function (node, body) {
    return '<b>' + node.uid + '</b><br><button data-action="copy">Copy uid</button>';
  },
  onSettle: function (result) {
    console.log(result.state, result.reason, result.frames + '/' + result.maxFrames);
  }
});
```

## Config reference

Passed as `options.config` to `create()`, or as a partial patch to `updateConfig()`/`load()`'s `loadOptions.config`. All fields optional — shown with their defaults.

### Top-level / diagnostics

| Field | Default | Description |
|---|---|---|
| `debug` | `false` | Opens the config/tweak panel on creation (`showDebugToggle`'s ⚙ button still toggles it live either way). |
| `logEvents` | `false` | Traces every control press, public method call, lifecycle transition and host callback invocation to the console. |
| `maxEdgesPerNode` | `15` | Keeps only the *k* strongest edges per node (symmetric kNN sparsification). Caps total drawn/simulated edges at `n × k` regardless of input density. `0` disables sparsification. |
| `hitThresholdCompute` | `0` | Positive edges exert physical force only if `weight >= this`. |
| `missThresholdCompute` | `0` | Negative edges exert physical force only if `weight <= this`. |
| `hitThresholdDraw` | `0` | Positive edges are drawn only if `weight >= this` (independent of whether they're computed). |
| `missThresholdDraw` | `0` | Negative edges are drawn only if `weight <= this`. |
| `lockAttractionRepulsion` | `true` | Internal physics coupling flag — see the dox before changing it. |

### Geometry & views

| Field | Default | Description |
|---|---|---|
| `geometry` | `'globe'` | Which embedding the canvas shows: `'plane'` (flat unit disk) or `'globe'` (sphere). Both layouts exist and are stepped together regardless of which is on screen; switching is a change of viewpoint only. |
| `showGeometryToggle` | `true` | The 2D/3D pill next to the view-mode toggle. Set `geometry` and turn this off together to force a geometry the host controls exclusively. |
| `viewMode` | `'relations'` | `'relations'` (every input edge, both signs — what drives the layout), `'proximity'` (nodes within `proximityMaxDistance`/`globeProximityMaxDistance` of each other in the *current* layout), or `'clusters'` (proximity graph, long edges cut, colored by connected component — parked, not in the toggle, but usable via `updateConfig`). `'proximity'`/`'clusters'` are only offered while the simulation is stopped. |
| `showViewModeToggle` | `true` | The Relations/Proximity pill. Also gates the automatic switch to `'proximity'` on convergence — hiding the toggle means the host owns `viewMode` outright. |
| `proximityMaxDistance` | `0.2` | Radius (world units, disk radius = 1) defining the `'proximity'` reading on the plane. |
| `globeProximityMaxDistance` | `0.4` | Same, for the globe — a separate field because the sphere's surface area is 4× the disk's, so an equivalent neighborhood is twice the radius. |
| `clusterQuantile` | `0.8` | Quantile of the proximity graph's own edge-length distribution beyond which edges are cut before taking connected components, for `'clusters'`. |

### Chrome visibility (all in `nodino.css`)

| Field | Default | Component |
|---|---|---|
| `showDebugToggle` | `true` | The ⚙ button (top-right) and, with `debug`, the config panel it opens. |
| `showSimControls` | `true` | Reset/Run/Pause/Force bar + state readout (top-right). |
| `showSearch` | `true` | uid search box + autocomplete (top-centre). |
| `showStats` | `true` | Node/edge counts (bottom-right). |
| `showRunTime` | `true` | Accumulated running time (bottom-left). |
| `showProgressBar` | `true` | Convergence-deadline bar (bottom edge). |
| `showPulse` | `true` | Perimeter opacity animation while running — purely cosmetic. |

A host that turns a chrome flag off is expected to drive the equivalent behavior itself through the public API (`start()`/`pause()` for `showSimControls`, `hover()`/`pin()` for `showSearch`, `onStateChange` for `showStats`/`showRunTime`, etc.).

### `physics.*`

The engine works in a normalized unit disk — every field below is a dimensionless ratio, never a length unit, so none of them need re-tuning for graph size.

| Field | Default | Description |
|---|---|---|
| `restLength` | `1` | Optimal edge length = `restLength × (1 - weight)`, in `[0, 2]` (the disk's diameter). |
| `attraction` | `1` | Attractive force multiplier. |
| `repulsion` | `1` | Repulsive force multiplier. |
| `repulsionSpacing` | `1.2` | Crowding radius = `repulsionSpacing / √nodeCount`. |
| `epsilonStart` | `0.005` | Initial numerical-stability epsilon. |
| `epsilonMax` | `0.05` | Ceiling epsilon ramps up to. |
| `epsilonDelta` | `0.001` | Per-frame ramp step. |
| `damping` | `0.75` | Velocity damping factor per step. |
| `maxStep` | `0.05` | Hard cap on per-frame displacement, in disk radii. |
| `stopVelocity` | `0.0004` | Mean per-frame displacement below which the layout is considered settled. |
| `stopFrames` | `40` | Consecutive steps below `stopVelocity` required before declaring settled. |
| `forcedStopVelocity` | `0.0001` | Stricter version of `stopVelocity`, used only in a forced run — the only thing that can end one. |
| `maxConvergenceSeconds` | `5` | Force settlement after this many seconds of *running* time (0 = no limit). Waived while forced. |
| `maxConvergenceFrames` | `7200` | Force settlement after this many steps (0 = no limit). Waived while forced. |

### `style.*` — canvas & perimeter

| Field | Default | Description |
|---|---|---|
| `backgroundColor` | `'#ffffff'` | Canvas background, inside the perimeter. |
| `outsideColor` | `'#f8f8fe'` | Fill outside the perimeter once the layout is settled (eased in/out). |
| `perimeterColor` | `'#000000'` | Boundary circle stroke color. |
| `perimeterWidth` | `1` | Boundary circle stroke width. |
| `perimeterIdleAlpha` | `0.5` | Perimeter opacity while `loaded`, not yet started. |
| `perimeterPulseSpeed` | `0.5` | Pulse rate while running (see `showPulse`). |
| `perimeterPulseMinAlpha` / `perimeterPulseMaxAlpha` | `0.2` / `0.8` | Pulse amplitude bounds. |
| `perimeterSettledAlpha` | `0.15` | Perimeter opacity once settled. |
| `settledTransitionDuration` | `600` | ms eased between running and settled perimeter/outside-tint states. |

### `style.*` — nodes & highlight

| Field | Default | Description |
|---|---|---|
| `nodeColor` / `nodeBorderColor` | `'#000000'` | Node fill / border. |
| `nodeRadius` | `1.5` | Base node radius, screen px. |
| `nodeBorderWidth` | `1` | Node border width, screen px. |
| `nodeRadiusZoomInThreshold` / `nodeRadiusZoomOutThreshold` | `3` / `0.5` | Multiples of the fit-to-view zoom beyond which node radius scales with zoom. |
| `nodeRadiusZoomInExponent` / `nodeRadiusZoomOutExponent` | `0.5` / `0.5` | Power-law exponent for that scaling. |
| `nodeRadiusMax` / `nodeRadiusMin` | `5` / `1` | Clamp on the scaled radius, screen px. |
| `highlightColor` / `highlightBorderColor` | `'#ffffff'` / `'#000000'` | Hovered/pinned node mark. |
| `highlightBorderWidth` | `1.5` | | |
| `highlightRadius` | `5` | Scales with the node's own current radius. |

### `style.*` — edges (`'relations'`)

| Field | Default | Description |
|---|---|---|
| `hitEdgeColor` | `'0,0,255'` | Positive-weight edges (RGB triplet string). |
| `missEdgeColor` | `'255,0,0'` | Negative-weight edges. |
| `edgeWidth` / `missEdgeWidth` | `1` / `1` | Stroke width per sign. |
| `maxHitAlpha` / `maxMissAlpha` | `0.25` / `0.15` | Opacity at `\|weight\| = 1`; scales down toward `minEdgeAlpha` at `\|weight\| = 0`. |
| `minEdgeAlpha` | `0` | Opacity floor. |

### `style.*` — `'proximity'` / `'clusters'`

| Field | Default | Description |
|---|---|---|
| `proximityEdgeColor` | `'0,140,120'` | Deliberately not blue — a different claim than a positive relation. |
| `proximityEdgeAlpha` | `0.15` | Flat opacity for every proximity edge. |
| `proximityEdgeWidth` / `proximityEdgeMaxWidth` | `1` / `3` | Width ramps with the underlying input weight between these. |
| `clusterEdgeWidth` | `1` | |
| `clusterSaturation` / `clusterLightness` | `0.55` / `0.45` | HSL generated per cluster (golden-angle hue spacing). |
| `clusterEdgeAlpha` | `0.5` | |
| `clusterMinSize` | `3` | Components smaller than this are drawn as unclustered (grey), not colored. |
| `clusterOutlierColor` | `'170,170,180'` | |

### `style.*` — globe only

| Field | Default | Description |
|---|---|---|
| `globeDepthMinAlpha` | `0.12` | Opacity floor for the far side of the sphere (depth cue). |
| `globeArcSegmentAngle` | `0.15` | Radians per tessellated segment of a surface edge. |
| `globeArcMaxSegments` | `24` | Hard cap on tessellation per edge. |
| `globeGraticuleMeridians` / `globeGraticuleParallels` | `12` / `5` | Coordinate-grid line counts. `0`/`0` disables the grid. |
| `globeGraticuleColor` | `'150,150,180'` | |
| `globeGraticuleAlpha` | `0.16` | |
| `globeGraticuleWidth` | `1` | |

## UI features (chrome)

Everything below is optional (each behind its own `show*` flag above) and requires `nodino.css`. All of it is built and torn down through `updateConfig()` — hiding a flag removes the component's DOM, not just its visibility.

- **Simulation controls** (`showSimControls`, top-right): Reset / Run / Pause / Force buttons plus a live state-name readout, driving the [lifecycle](#lifecycle) directly. Illegal transitions grey their button out rather than hiding it.
- **Debug/config panel** (`showDebugToggle` + `debug`, top-right): a live tweak panel over every `physics.*`/`style.*` field and the proximity radii, for development. Not meant for a shipped embedding's normal chrome — it edits `config` directly through `updateConfig()`.
- **Geometry toggle** (`showGeometryToggle`, top-centre): switches `config.geometry` between `'plane'` (2D) and `'globe'` (3D). Icon + label on each button.
- **View-mode toggle** (`showViewModeToggle`, top-centre): switches `config.viewMode` between Relations and Proximity. Proximity is greyed out while the simulation is running (it reads a settled layout) and the widget switches to it automatically on convergence, unless this toggle is hidden.
- **Search** (`showSearch`, top-centre): a uid text box with an autocomplete list (prefix matches first, then substring, capped at 12). A row hovers on cursor-over and pins on click — the same two gestures a node itself answers.
- **Detail panel** (always on if `onNodeHover`/`onNodePin` are used — not behind a flag): a hover card that follows the cursor (click-through) and a pinned card that follows its node across pan/zoom/rotation/running layout (`pointer-events: auto`, so host-injected buttons/links are clickable). One click moves the pin; `Esc`, a click on the background, or a click on the pinned node again releases it.
- **Stats readout** (`showStats`, bottom-right): `"N nodes · M edges"`, or `"M of K edges"` when `maxEdgesPerNode` sparsified the input.
- **Run-time readout** (`showRunTime`, bottom-left): accumulated running seconds + total step count.
- **Progress bar** (`showProgressBar`, bottom edge): tracks whichever convergence budget (seconds/frames) is further along. Visible only in `running`/`running_paused`.
- **Perimeter pulse** (`showPulse`): the boundary circle's opacity itself communicates state — flat while idle, pulsing while running, faint once settled. Purely cosmetic; nothing reads it back.

## Interaction (mouse / touch)

All of it works identically with mouse or touch (Pointer Events, `touch-action: none`):

| Gesture | Mouse | Touch |
|---|---|---|
| Pan | Drag background (primary button); on the globe, middle-drag or Shift-drag | One-finger drag; on the globe, two-finger drag |
| Zoom | Wheel, or two-finger pinch | Two-finger pinch |
| Rotate (globe only) | Primary drag | One-finger drag |
| Hover | Cursor over a node | — (no touch equivalent; a touch drag would open the panel under the finger doing the panning) |
| Pin / unpin | Click a node / click background, `Esc`, or click the pinned node again | Tap a node / tap background, tap the pinned node again |

Zoom is clamped to `[0.25×, 250×]` of the fit-to-view level. Pan is bounded to the graph's own extent plus a margin proportional to the current viewport — the graph can be pushed to the edge of view and a little past it, never off it entirely.
