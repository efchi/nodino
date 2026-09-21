// Type declarations for @efchi/nodino. Hand-written mirror of API-DOCS.md and
// DEFAULT_CONFIG in nodino.js — keep all three in step (see CLAUDE.md).

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
  body: HTMLElement
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
  outsideColor: string;
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
}

export interface NodinoConfig {
  debug: boolean;
  logEvents: boolean;
  maxEdgesPerNode: number;
  hitThresholdCompute: number;
  missThresholdCompute: number;
  hitThresholdDraw: number;
  missThresholdDraw: number;
  lockAttractionRepulsion: boolean;

  geometry: 'plane' | 'globe';
  viewMode: 'relations' | 'proximity' | 'clusters';
  proximityMaxDistance: number;
  globeProximityMaxDistance: number;
  clusterQuantile: number;

  showDebugToggle: boolean;
  showSimControls: boolean;
  showSearch: boolean;
  showStats: boolean;
  showRunTime: boolean;
  showProgressBar: boolean;
  showPulse: boolean;
  showGeometryToggle: boolean;
  showViewModeToggle: boolean;

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
}

export interface NodinoLoadOptions {
  onNodeHover?: NodinoNodeHandler;
  /** Defaults to `onNodeHover` if omitted. */
  onNodePin?: NodinoNodeHandler;
  onSettle?: (result: NodinoResult) => void;
  onPause?: (result: NodinoResult) => void;
  /** Patch scoped to this dataset; persists past the `load()` call. */
  config?: NodinoConfigPatch;
}

export interface NodinoInstance {
  /** Replaces any previous graph. Never starts the simulation. */
  load(data: NodinoLoadData, loadOptions?: NodinoLoadOptions): void;
  start(): void;
  pause(): void;
  forceContinue(): void;
  restart(): void;
  updateConfig(partial?: NodinoConfigPatch): void;
  /** `false` if the uid is not in this graph. */
  pin(uid: string): boolean;
  /** Whether there was a pin to release. */
  unpin(): boolean;
  /** `false` if the uid is not in this graph. */
  hover(uid: string): boolean;
  /** Whether there was a hover to end. */
  unhover(): boolean;
  /** A fresh snapshot, shaped like `load()`'s `data.positions`. */
  getPositions(): { [uid: string]: NodinoPosition };
  /** A fresh snapshot, shaped like `load()`'s `data.globePositions`. */
  getGlobePositions(): { [uid: string]: NodinoGlobePosition };
  getStats(): NodinoStats;
  destroy(): void;
}

/** Browser only — `create()` touches the DOM. Importing this module server-side is safe. */
export function create(container: HTMLElement, options?: NodinoCreateOptions): NodinoInstance;

declare const Nodino: { create: typeof create };
export default Nodino;
