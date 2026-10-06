// Type declarations for @efchi/nodino. Hand-written mirror of API-DOCS.md and
// DEFAULT_CONFIG in nodino.js — keep all three in step (see CLAUDE.md).
//
// CommonJS form (`export =`), matching nodino.js's `module.exports = { create }`.
// The ESM twin, nodino.d.mts, is generated from this file by scripts/build.mjs:
// everything between the two BODY markers is copied out, de-indented, and given
// an `export default` — edit here, never there.

declare namespace Nodino {
  // BODY:BEGIN
  /** Lifecycle state of an instance. See API-DOCS.md § Lifecycle. */
  export type NodinoState =
    | 'empty'
    | 'loaded'
    | 'running'
    | 'running_paused'
    | 'settled'
    | 'forced'
    | 'forced_paused'
    | 'forced_settled'
    | 'destroyed';

  /** `m` = metadata, opaque to Nodino — handed back verbatim to onNodeHover/onNodePin. */
  export interface NodinoNodeEntry {
    m?: object;
  }

  /** `[sourceUid, targetUid, weight]`, weight in [-1, 1]. Positive attracts, negative repels. */
  export type NodinoEdgeInput = [source: string, target: string, weight: number];

  /** In [-1, 1], relative to the unit boundary circle. */
  export interface NodinoPosition {
    x: number;
    y: number;
  }

  /** A vector on the unit sphere — renormalized on the way in. */
  export interface NodinoGlobePosition {
    x: number;
    y: number;
    z: number;
  }

  export interface NodinoLoadData {
    /** Required. A node exists as soon as an edge names it. */
    edges: NodinoEdgeInput[];
    nodes?: { [uid: string]: NodinoNodeEntry };
    /** Planar bootstrap/result. Covering every node makes it a finished layout: `load()` opens `'settled'`. */
    positions?: { [uid: string]: NodinoPosition };
    /** Spherical bootstrap/result, independent of `positions`. */
    globePositions?: { [uid: string]: NodinoGlobePosition };
    /** Best step count a previous run of this graph reached, if the host is caching it. */
    maxFrames?: number;
    /** With complete positions: `false` = saved mid-run, opens `'running_paused'`; default `true` = opens `'settled'`. */
    settled?: boolean;
  }

  /** Payload of `onSettle` and `onPause`. */
  export interface NodinoResult {
    frames: number;
    maxFrames: number;
    state: NodinoState;
    reason: 'converged' | 'capped' | 'timeout' | 'paused';
    /** Identifies the graph's uid set — stable across host iteration order. */
    hash: string;
  }

  export interface NodinoNode {
    uid: string;
    m: object | null;
  }

  /**
   * Fill the detail panel's body: write DOM into `body` directly, return an HTML
   * string (or a Promise of one), or return nothing.
   */
  export type NodinoNodeHandler = (
    node: NodinoNode,
    /** The card's content slot, emptied before each call. */
    body: HTMLElement,
    /**
     * The card element, reset to Nodino's own classes and no inline style before
     * each call. Add classes, inline styles, data-* freely; don't remove
     * `nodino-detail-panel`/`nodino-pinned`, set left/top/display, or replace its
     * children.
     */
    card: HTMLElement
  ) => string | void | Promise<string | void>;

  export interface NodinoStats {
    state: NodinoState;
    /** True in both `'settled'` and `'forced_settled'`. */
    settled: boolean;
    nodeCount: number;
    /** After sparsification (`maxEdgesPerNode`). */
    edgeCount: number;
    /** Before sparsification. */
    inputEdgeCount: number;
    frames: number;
    maxFrames: number;
  }

  export interface NodinoPhysicsConfig {
    restLength: number;
    attraction: number;
    repulsion: number;
    repulsionSpacing: number;
    epsilonStart: number;
    epsilonMax: number;
    epsilonDelta: number;
    damping: number;
    maxStep: number;
    stopVelocity: number;
    stopFrames: number;
    forcedStopVelocity: number;
    maxConvergenceSeconds: number;
    maxConvergenceFrames: number;
  }

  /** Colors written as `'r,g,b'` triplet strings (edge/graticule/cluster) are marked in the field docs. */
  export interface NodinoStyleConfig {
    backgroundColor: string;
    /** 6-digit hex; outside the perimeter while not settled. */
    outsideBackgroundColor: string;
    outsideColor: string;
    /** 6-digit hex; the disk's fill once the layout has converged, in every view. */
    settledBackgroundColor: string;
    perimeterColor: string;
    perimeterWidth: number;
    perimeterIdleAlpha: number;
    perimeterPulseSpeed: number;
    perimeterPulseMinAlpha: number;
    perimeterPulseMaxAlpha: number;
    perimeterSettledAlpha: number;
    settledTransitionDuration: number;

    nodeColor: string;
    nodeBorderColor: string;
    nodeRadius: number;
    nodeBorderWidth: number;
    nodeRadiusZoomInThreshold: number;
    nodeRadiusZoomOutThreshold: number;
    nodeRadiusZoomInExponent: number;
    nodeRadiusZoomOutExponent: number;
    nodeRadiusMax: number;
    nodeRadiusMin: number;
    highlightColor: string;
    highlightBorderColor: string;
    highlightBorderWidth: number;
    highlightRadius: number;

    /** Multiple of the fit-to-view zoom below which no label is drawn. */
    labelMinZoom: number;
    labelMaxCount: number;
    /** Screen px, fixed regardless of zoom. */
    labelFontSize: number;
    labelFontFamily: string;
    /** Any CSS font-weight. */
    labelFontWeight: string | number;
    /** 6-digit hex. */
    labelColor: string;
    /** Side of the node the label sits on. */
    labelPosition: 'right' | 'left' | 'top' | 'bottom';
    /** RGB triplet string; opacity is `labelHaloAlpha`. */
    labelHaloColor: string;
    labelHaloAlpha: number;
    /** Screen px the halo extends around the letters; `0` removes it. */
    labelHaloWidth: number;
    /** Screen px of clear space kept around each label. */
    labelPadding: number;

    /** RGB triplet string, e.g. `'0,0,255'`. */
    hitEdgeColor: string;
    /** RGB triplet string. */
    missEdgeColor: string;
    edgeWidth: number;
    missEdgeWidth: number;
    maxHitAlpha: number;
    maxMissAlpha: number;
    minEdgeAlpha: number;

    /** RGB triplet string. */
    proximityEdgeColor: string;
    proximityEdgeAlpha: number;
    proximityEdgeWidth: number;
    proximityEdgeMaxWidth: number;
    clusterEdgeWidth: number;
    clusterSaturation: number;
    clusterLightness: number;
    clusterEdgeAlpha: number;
    clusterMinSize: number;
    /** RGB triplet string. */
    clusterOutlierColor: string;

    globeDepthMinAlpha: number;
    globeArcSegmentAngle: number;
    globeArcMaxSegments: number;
    globeGraticuleMeridians: number;
    globeGraticuleParallels: number;
    /** RGB triplet string. */
    globeGraticuleColor: string;
    globeGraticuleAlpha: number;
    globeGraticuleWidth: number;
    /** Camera-space depth (0 = rim, 1 = facing the viewer) below which a node gets no label on the globe. */
    globeLabelMinDepth: number;
  }

  /** Names of the built-in themes. */
  export type NodinoThemeName = 'light' | 'constellation';

  /** A colour theme: a label and the `style` colours it sets. */
  export interface NodinoTheme {
    readonly label: string;
    readonly style: Readonly<Partial<NodinoStyleConfig>>;
  }

  export interface NodinoConfig {
    debug: boolean;
    /** Colour theme applied when set; colours in the same patch win. */
    theme: NodinoThemeName;
    /** Master switch for console output (warnings and the logEvents trace). The startup banner is always printed. */
    logging: boolean;
    logEvents: boolean;
    maxEdgesPerNode: number;
    hitThresholdCompute: number;
    missThresholdCompute: number;
    hitThresholdDraw: number;
    missThresholdDraw: number;
    lockAttractionRepulsion: boolean;

    geometry: 'plane' | 'globe';
    viewMode: 'relations' | 'proximity' | 'clusters';
    /** 'auto': the proximity radius scales with the node count; 'fixed': the two absolute radii below. */
    proximityRadius: 'auto' | 'fixed';
    /** 'auto' only: average neighbours per node aimed at. */
    proximityNeighbors: number;
    /** 'fixed' only. */
    proximityMaxDistance: number;
    /** 'fixed' only. */
    globeProximityMaxDistance: number;
    clusterQuantile: number;

    showDebugToggle: boolean;
    showSimControls: boolean;
    showSearch: boolean;
    /** Maximum rows in the search autocomplete list (default 12). */
    searchMaxResults: number;
    showStats: boolean;
    showRunTime: boolean;
    showProgressBar: boolean;
    showPulse: boolean;
    showNodeLabels: boolean;
    showGeometryToggle: boolean;
    showViewModeToggle: boolean;
    showLabelsToggle: boolean;

    physics: NodinoPhysicsConfig;
    style: NodinoStyleConfig;
  }

  /** A partial patch onto the live config — deep-merged, never replaced. */
  export type NodinoConfigPatch = {
    [K in keyof NodinoConfig]?: NodinoConfig[K] extends object
      ? Partial<NodinoConfig[K]>
      : NodinoConfig[K];
  };

  export interface NodinoCreateOptions {
    config?: NodinoConfigPatch;
    /** Fires on every lifecycle transition, engine-driven ones included. Not called for the initial `'empty'`. */
    onStateChange?: (state: NodinoState) => void;
    /** A click/tap on a node. Default: pin (or release) it. */
    onNodeClick?: (event: NodinoEvent) => void;
    /** The hovered node changes. Default: show its card and highlight (ending a hover is not cancelable). */
    onHoverChange?: (event: NodinoEvent) => void;
    /** The pinned node changes, by any route. Default: the change itself (a load()/restart() release is not cancelable). */
    onPinChange?: (event: NodinoEvent) => void;
  }

  /** Passed to the node event handlers; fired before Nodino reacts. */
  export interface NodinoEvent {
    type: 'click' | 'hoverchange' | 'pinchange';
    /** The node (for a change: the new one), or `null`. */
    uid: string | null;
    m: object | null;
    /** Change events only: the uid before the change, or `null`. */
    previous?: string | null;
    source: 'pointer' | 'keyboard' | 'search' | 'api' | 'reload';
    originalEvent: Event | null;
    cancelable: boolean;
    defaultPrevented: boolean;
    /** Skips Nodino's own reaction, if `cancelable`. */
    preventDefault(): void;
  }

  export interface NodinoLoadOptions {
    onNodeHover?: NodinoNodeHandler;
    /** Defaults to `onNodeHover` if omitted. */
    onNodePin?: NodinoNodeHandler;
    onSettle?: (result: NodinoResult) => void;
    onPause?: (result: NodinoResult) => void;
    /** Canvas label text for a node; `null`/`''` draws none. Defaults to the uid. Called once per node per (re)build. */
    nodeLabel?: (uid: string, m: object | null) => string | null;
    /** Label rank, higher first. Defaults to the node's strength (sum of its positive input weights). Called once per node per (re)build. */
    nodePriority?: (uid: string, m: object | null) => number;
    /** Patch scoped to this dataset; persists past the `load()` call. */
    config?: NodinoConfigPatch;
  }

  /** Argument of `update()`. Applied in field order: removeEdges, removeNodes, addNodes, addEdges. */
  export interface NodinoUpdatePatch {
    removeEdges?: [source: string, target: string][];
    removeNodes?: string[];
    /** An existing uid only gets its metadata replaced. */
    addNodes?: { [uid: string]: NodinoNodeEntry };
    /** Both endpoints must exist or be in `addNodes`; an existing pair gets its weight replaced. */
    addEdges?: NodinoEdgeInput[];
    /** Starting positions for new nodes only. */
    positions?: { [uid: string]: NodinoPosition };
    globePositions?: { [uid: string]: NodinoGlobePosition };
  }

  export interface NodinoInstance {
    /** Replaces any previous graph. Never starts the simulation. */
    load(data: NodinoLoadData, loadOptions?: NodinoLoadOptions): void;
    /** Edits the loaded graph in place, in any state. `true` if anything changed. */
    update(patch: NodinoUpdatePatch): boolean;
    start(): void;
    pause(): void;
    forceContinue(): void;
    restart(): void;
    updateConfig(partial?: NodinoConfigPatch): void;
    /**
     * `false` if the uid is not in this graph, or onPinChange prevented it. With `autoRotate`, on the globe a
     * node on the far side is turned round to the centre of the view, as a
     * search pick does; no effect on the plane or for a node already in front.
     */
    pin(uid: string, options?: { autoRotate?: boolean }): boolean;
    /** Whether there was a pin to release. */
    unpin(): boolean;
    /** `false` if the uid is not in this graph. */
    hover(uid: string): boolean;
    /** Whether there was a hover to end. */
    unhover(): boolean;
    /** uid of the pinned node, or `null`. */
    getPinned(): string | null;
    /** uid of the hovered node, or `null`. */
    getHovered(): string | null;
    /** A fresh snapshot, shaped like `load()`'s `data.positions`. */
    getPositions(): { [uid: string]: NodinoPosition };
    /** A fresh snapshot, shaped like `load()`'s `data.globePositions`. */
    getGlobePositions(): { [uid: string]: NodinoGlobePosition };
    getStats(): NodinoStats;
    destroy(): void;
  }

  /** The built-in themes, read-only. */
  export const themes: { readonly [name in NodinoThemeName]: NodinoTheme };

  /** `DEFAULT_CONFIG`, read-only (deep-frozen copy): what every field is before any patch. */
  export const defaults: Readonly<NodinoConfig>;

  /** Browser only — `create()` touches the DOM. Importing this module server-side is safe. */
  export function create(container: HTMLElement, options?: NodinoCreateOptions): NodinoInstance;
  // BODY:END
}

export = Nodino;
