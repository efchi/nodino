# Nodino — API Reference

Exhaustive interface reference for `nodino.js` (+ `nodino.css` for its optional chrome). For *why* things work this way, see [`nodino.dox.md`](nodino.dox.md) — this document only covers *what* is exposed and *how* to call it.

- No build step, no dependencies. Two files: `nodino.js` (logic + canvas rendering) and `nodino.css` (optional menu/chrome styling — only needed if any chrome flag below is on).
- Deterministic: the same input (data + config) always produces the same layout, on any machine, on any run. `nodino.js` never calls `Math.random()`.
- Graph size: Nodino should work well below ~1,000 nodes and stay usable up to a few thousand (roughly 1,000–5,000). Beyond that it depends heavily on the machine running it; `maxEdgesPerNode` keeps the edge count bounded at any size.

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

## Installation

**npm** — `npm install @efchi/nodino`. The package ships both an ES module and a CommonJS build, with TypeScript declarations for each (picked up automatically):

```js
import Nodino from '@efchi/nodino';        // or: import { create, themes, defaults } from '@efchi/nodino';
                                           // or: const Nodino = require('@efchi/nodino');
import '@efchi/nodino/nodino.css';         // only if any chrome flag below is on
```

Importing is safe on the server (SSR, tooling) — nothing touches the DOM until [`create()`](#nodinocreatecontainer-options) is called, and `create()` is browser-only (call it from a client-side effect/lifecycle hook, once the container element exists). In a bundled app `Nodino` is only what you import — no `window.Nodino` is set.

**Script tag** — link `nodino.js` (and `nodino.css`) directly, as in the snippet above; this defines the global `window.Nodino`. From a CDN: `https://cdn.jsdelivr.net/npm/@efchi/nodino/nodino.min.js` and `.../nodino.min.css`.

**Native ES module** — no bundler, no global:

```html
<script type="module">
  import Nodino from 'https://cdn.jsdelivr.net/npm/@efchi/nodino/nodino.min.mjs';
</script>
```

| File | Format | Use |
|---|---|---|
| `nodino.js` / `nodino.min.js` | script (global `window.Nodino`) or CommonJS | `<script src>`, `require()` |
| `nodino.mjs` / `nodino.min.mjs` | ES module | `import`, `<script type="module">` |
| `nodino.css` / `nodino.min.css` | stylesheet | `<link>`, or `import '@efchi/nodino/nodino.css'` (also `/nodino.min.css`) |

The `.min` files are the same code minified; the unminified ones are commented and readable.

## Contents

1. [`Nodino.create()`](#nodinocreatecontainer-options)
2. [Instance methods](#instance-methods)
3. [Lifecycle](#lifecycle)
4. [Data shapes](#data-shapes)
5. [Callbacks](#callbacks)
6. [Config reference](#config-reference)
7. [UI features (chrome)](#ui-features-chrome)
8. [Interaction (mouse / touch)](#interaction-mouse--touch)
9. [Security](#security)
10. [Accessibility](#accessibility)

## `Nodino.create(container, options)`

Creates one graph instance inside `container`. Does **not** load or draw any data — call [`load()`](#loaddata-loadoptions) next.

| Param | Type | Notes |
|---|---|---|
| `container` | `HTMLElement` | Must have a size. `create()` sets `position: relative` on it if its computed position is `static`, and unconditionally sets `overflow: hidden` — both restored to whatever they were before on `destroy()`. Chrome is appended as absolutely-positioned children. |
| `options.config` | `object` | Optional. A partial patch onto [`DEFAULT_CONFIG`](#config-reference) — deep-merged, so `{ style: { nodeColor: '#f00' } }` only overrides that one field. |
| `options.onStateChange` | `(state: NodinoState) => void` | Optional. Fires on every [lifecycle](#lifecycle) transition, including the two the engine makes on its own (reaching convergence). Not called for the initial `'empty'`. The way to mirror lifecycle state into a host's own UI without polling `getStats()`. |
| `options.onNodeClick` / `onHoverChange` / `onPinChange` | `(event: NodinoEvent) => void` | Optional. [Node events](#node-events) — react to clicks, hover and selection, and `preventDefault()` Nodino's own reaction. |

Returns an **instance** — the object documented below. Multiple instances (multiple containers) are fully independent.

```js
var nodino = Nodino.create(el, {
  config: { maxEdgesPerNode: 15, style: { nodeColor: '#1a1a3a' } },
  onStateChange: function (state) { console.log('[nodino]', state); }
});
```

## Instance methods

Every method below except the getters is a no-op with a `console.warn` if called on a `'destroyed'` instance — the node verbs (`pin`/`unpin`/`hover`/`unhover`) then return `false`. The getters keep answering (`getStats().state` is how you see `'destroyed'`). All warnings in this document are printed only while `config.logging` is on. The four lifecycle verbs (`start`/`pause`/`forceContinue`/`restart`) additionally refuse (`console.warn`, no state change) when the *current* state has no transition for that action — see the [table](#lifecycle). They return nothing either way, so a refusal is visible only through the warning and the unchanged state (`getStats().state` / `onStateChange`). `load()` and `destroy()` are legal in every state but `'destroyed'`.

### `load(data, loadOptions)`

The sole data-ingestion entry point — **replaces any previous graph**. Never starts the simulation: the loaded layout is drawn at rest, and running it is a separate, explicit `start()`. Legal from every state but `'destroyed'`, `'empty'` and `'loaded'` included, since the data itself is what's changing.

| Param | Type | Notes |
|---|---|---|
| `data` | [`NodinoLoadData`](#nodinoloaddata) | Required. `edges` is the only mandatory field. |
| `loadOptions.onNodeHover` | `(node, body) => any` | Optional. See [Callbacks](#callbacks). |
| `loadOptions.onNodePin` | `(node, body) => any` | Optional. Defaults to `onNodeHover` if omitted. |
| `loadOptions.onSettle` | `(result: NodinoResult) => void` | Optional. |
| `loadOptions.onPause` | `(result: NodinoResult) => void` | Optional. |
| `loadOptions.nodeLabel` | `(uid, m) => string \| null` | Optional. Text of the node's canvas [label](#node-labels); `null`/`''` = no label for that node. Defaults to the uid. |
| `loadOptions.nodePriority` | `(uid, m) => number` | Optional. Label rank, higher first. Defaults to the node's strength (sum of its positive input weights). |
| `loadOptions.config` | `object` | Optional. A partial config patch scoped to *this* dataset (e.g. a denser graph wanting a different `maxEdgesPerNode`) — same deep-merge semantics as `updateConfig()`, and it persists past this one `load()` call. |

Callbacks are replaced wholesale per `load()`, not accumulated — omitting `onSettle` means nothing is listening for *this* graph's convergence, not that the previous dataset's handler carries over.

```js
nodino.load(
  { edges: [['apple', 'pear', 0.9], ['apple', 'hammer', -0.5]] },
  { onNodeHover: function (node) { return '<b>' + node.uid + '</b>'; } }
);
```

### `update(patch)`

Edits the graph already loaded — add and remove nodes and edges — without reloading it, in any state (mid-run included). Returns `true` if anything changed.

```js
nodino.update({
  removeEdges: [['n1', 'n2']],
  removeNodes: ['n4'],                       // with all their edges
  addNodes:    { n9: { m: { title: 'New' } } },
  addEdges:    [['n9', 'n3', 0.8], ['n9', 'n5', -0.2]],
  positions:   { n9: { x: 0.1, y: -0.2 } }   // optional, new nodes only
});
```

| Field | Notes |
|---|---|
| `removeEdges` | `[uid, uid]` pairs, either direction. |
| `removeNodes` | uids; their edges go with them. |
| `addNodes` | `{ [uid]: { m? } }`. An existing uid only gets its metadata replaced (no restart). |
| `addEdges` | `[uid, uid, weight]`. An existing pair gets its weight replaced. Both endpoints must exist (or be in `addNodes`) — **unlike `load()`, an edge does not create its nodes.** |
| `positions` / `globePositions` | Optional starting position for *new* nodes, same shapes as in `load()`. Default: the weighted mean of the node's positively related neighbours, or the centre. |

Applied in the order above, as a single rebuild. Unknown uids/edges are ignored with a console warning.

| State before | After |
|---|---|
| `'empty'`, `'loaded'` | Rebuilt like a `load()` of the edited data (initial layout from scratch, existing nodes may move); stays stopped. |
| `'running'`, `'forced'` | `'running'`, continuing from the current layout. |
| `'settled'`, `'forced_settled'` | `'running'`, until a new convergence. |
| `'running_paused'`, `'forced_paused'` | `'running_paused'` — the edit is visible, the run resumes when you resume it. |

- Existing nodes keep their position; pin and hover survive (released, with `source: 'update'`, if their node is removed).
- An edit counts as a new graph: `frames`/`maxFrames` restart from 0, the convergence budgets start over, `onSettle`'s `hash` changes.
- Once edited mid-run, a layout depends on when each edit arrived, so it is not reproducible across sessions; `restart()` replays the edited graph from scratch and is deterministic again.
- Nodino edits its own copy of the data — the object you passed to `load()` is never modified.

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
nodino.updateConfig({ geometry: 'plane', style: { nodeColor: '#1a1a3a' } });
```

### `pin(uid, options?)` / `unpin()`

Pins/releases the detail card to the named node — the same thing a click on the node does ([F Interact.3]). `pin()` on a uid this graph does not have returns `false` with a console warning (a question about the data, not a refusal of the call); it also returns `false` if `onPinChange` prevented the change ([node events](#node-events)). Not gated by lifecycle state — a pin is legible in every state a graph exists in.

| Option | Type | Notes |
|---|---|---|
| `options.autoRotate` | `boolean` | Default `false`. On the globe, if the node is on the far side, turn the globe to bring it under the centre of the view — the same animated turn a search pick makes. No effect on the plane, or for a node already facing the viewer. Pan and zoom are unchanged. |

```js
instance.pin('n42', { autoRotate: true });
```

### `hover(uid)` / `unhover()`

Same pair for the hover card — the same thing the cursor arriving on a node does. Also ungated by lifecycle state.

### `getPinned()` / `getHovered()`

Return the uid of the node whose card is pinned / hovered, or `null` — whatever put it there (mouse, search list, or `pin()`/`hover()`). Ungated by lifecycle state. To be notified instead of polling, use the [node events](#node-events).

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
  maxFrames?: number,                                 // best step count a previous run of this graph reached, if the host is caching it
  settled?: boolean                                   // with complete positions: false = saved mid-run, opens 'running_paused' (Run resumes); default true = opens 'settled'
}
```

Positions covering every node are a finished layout: `load()` opens `'settled'` (Force and Reset available). If they were saved mid-run — e.g. from `onPause`, or after pausing — pass `settled: false` and the graph reopens `'running_paused'`, so Run resumes it.

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
| `onNodeClick` | `create()` | `(event: NodinoEvent) => void` — see [Node events](#node-events) |
| `onHoverChange` | `create()` | same |
| `onPinChange` | `create()` | same |
| `onNodeHover` | `load()` | `(node: { uid: string, m: object \| null }, body: HTMLElement, card: HTMLElement) => any` |
| `onNodePin` | `load()` | same as `onNodeHover`; defaults to it if omitted |
| `onSettle` | `load()` | `(result: NodinoResult) => void` |
| `onPause` | `load()` | `(result: NodinoResult) => void` |
| `nodeLabel` | `load()` | `(uid: string, m: object \| null) => string \| null` — called once per node per (re)build, not per frame |
| `nodePriority` | `load()` | `(uid: string, m: object \| null) => number` — same; a non-finite result ranks last |

**`onNodeHover`/`onNodePin`** are handed the node, the detail panel's body element — an empty `<div>` under the uid title, cleared before every call — and the card element itself (see [Styling the card](#styling-the-card)). Three ways to fill the body, in order of precedence:

1. Write DOM into `body` directly (listeners included).
2. Return an HTML string — replaces `body`'s contents.
3. Return a `Promise` of one of the above — the slot holds whatever was written synchronously (e.g. a loading spinner) until the promise resolves, then the resolved string replaces it.

> **Security:** a returned string is inserted as HTML, unsanitized. Escape anything that comes from an untrusted source — see [Security](#security).

Return/write nothing and the title (the uid) stays the only content. (To *replace* the card rather than fill it, prevent it through the [node events](#node-events).) `onNodePin`'s card takes the mouse (`pointer-events: auto`) — put buttons and links there, not in `onNodeHover`'s (click-through, since it follows the cursor).

```js
nodino.load(data, {
  onNodeHover: function (node, body) {
    // escapeHtml: see Security below — uids and metadata are data, not markup.
    return '<b>' + escapeHtml(node.uid) + '</b><br>' + (node.m ? escapeHtml(node.m.kind) : '');
  },
  onNodePin: function (node, body) {
    return '<b>' + escapeHtml(node.uid) + '</b><br><button data-action="copy">Copy uid</button>';
  },
  onSettle: function (result) {
    console.log(result.state, result.reason, result.frames + '/' + result.maxFrames);
  }
});
```

### Styling the card

The third argument, `card`, is the card element (`<div class="nodino-detail-panel">`, plus `nodino-pinned` on the pinned card). Use it to style a card per node:

```js
onNodeHover: function (node, body, card) {
  card.classList.add('kind-' + node.m.kind);   // e.g. a coloured border per kind, in your CSS
  card.dataset.kind = node.m.kind;
  return escapeHtml(node.m.title);
}
```

**Before every call the card is reset** to Nodino's own classes and no inline style, so whatever you add lasts for that node only — no cleanup needed.

| You can | Don't |
|---|---|
| Add/remove your own classes (`classList`) | Remove or replace `nodino-detail-panel` / `nodino-pinned` — so don't assign `card.className` either |
| Set inline styles (`color`, `borderColor`, `background`, …) | Set `left`, `top`, `display` — Nodino positions and shows/hides the card, and overwrites them |
| Set `data-*` attributes | Remove or replace the card's children (`.nodino-detail-title`, `.nodino-detail-body`) — write into `body` instead |

The card's default look is in `nodino.css` (`.nodino-detail-panel`, `.nodino-pinned`, `.nodino-detail-title`, `.nodino-detail-body`); your own classes can override any of it.

### Node events

Passed to `create()`. Each fires **before** Nodino reacts, with an event object; on a cancelable event, `preventDefault()` skips Nodino's own reaction so you can do something else instead.

| Handler | Fires on | Default action (skipped by `preventDefault()`) |
|---|---|---|
| `onNodeClick` | a click/tap on a node | pin the node (or release it, if it was already pinned) |
| `onHoverChange` | the hovered node changes (mouse, search list, `hover()`/`unhover()`) | show the hover card and highlight. Ending a hover (`uid: null`) is not cancelable. |
| `onPinChange` | the pinned node changes, by any route (click, background click, `Esc`, search pick, `pin()`/`unpin()`, release by `load()`/`restart()`) | the change itself. The release by `load()`/`restart()` is not cancelable. |

The event object (`NodinoEvent`):

| Field | |
|---|---|
| `type` | `'click'`, `'hoverchange'` or `'pinchange'` |
| `uid`, `m` | the node (for a change: the new one) and its metadata; `null` when the change is to "none" |
| `previous` | change events only: the uid before the change, or `null` |
| `source` | `'pointer'`, `'keyboard'`, `'search'`, `'api'` (your own `pin()`/`hover()`…) or `'reload'` |
| `originalEvent` | the DOM event, when there is one |
| `cancelable`, `defaultPrevented`, `preventDefault()` | as in the DOM |

`pin()` returns `false` if its change was prevented. If you call `pin()`/`unpin()` from inside `onPinChange`, call `preventDefault()` too, or the original change is applied after yours.

```js
var nodino = Nodino.create(el, {
  // Keep your own selection UI in step (uid or null).
  onPinChange: function (e) { selectInMyList(e.uid); },
  // A click opens the node's page instead of pinning it.
  onNodeClick: function (e) { e.preventDefault(); location.href = '/items/' + encodeURIComponent(e.uid); },
  // Your own tooltip instead of Nodino's hover card.
  onHoverChange: function (e) {
    if (e.uid) { e.preventDefault(); showMyTooltip(e.uid, e.m); } else { hideMyTooltip(); }
  }
});
nodino.getPinned();   // 'n42' or null
```

### Themes

A theme is a named set of `style` colours (backgrounds, perimeter, nodes, highlight, labels, edges, proximity, the globe's grid). Two are built in: `'light'` (the defaults) and `'constellation'` (dark, night-blue background with pale nodes and edges).

```js
Nodino.create(el, { config: { theme: 'constellation' } });
nodino.updateConfig({ theme: 'light' });

// A theme as a starting point: colours in the same patch override it.
nodino.updateConfig({ theme: 'constellation', style: { nodeColor: '#ffd27a' } });

// The themes themselves, read-only (Nodino.themes, or import { themes }):
Nodino.themes.constellation.style.backgroundColor;   // '#0b1530'
```

Only colours change — sizes and physics stay as they are. The menus (`nodino.css`) follow the theme too: Nodino puts a `nodino-theme-<name>` class on the container, and every chrome colour is a CSS custom property (`--nodino-ink`, `--nodino-surface`, `--nodino-button-*`, `--nodino-card-*`, …) redefined under that class. Override those properties to restyle the chrome, and add the same class to your own panels to match the theme. `config.theme` records the last theme applied; editing a colour afterwards doesn't change it. An unknown name is ignored with a console warning. The debug panel's **Themes** group does the same thing interactively.

## Config reference

Passed as `options.config` to `create()`, or as a partial patch to `updateConfig()`/`load()`'s `loadOptions.config`. All fields optional — shown with their defaults.

The defaults themselves are readable as `Nodino.defaults` (or `import { defaults }`): a deep-frozen copy of the whole config, every field at its default. Useful to put back a field a dataset-scoped `loadOptions.config` changed — that patch persists past its `load()` — or to compare a config against the defaults.

```js
Nodino.defaults.physics.repulsionSpacing;   // 1.2
// Undo a dataset's own setting on the next load:
nodino.load(nextData, { config: { physics: { repulsionSpacing: Nodino.defaults.physics.repulsionSpacing } } });
```

### Top-level / diagnostics

| Field | Default | Description |
|---|---|---|
| `debug` | `false` | Opens the config/tweak panel on creation (`showDebugToggle`'s ⚙ button still toggles it live either way). |
| `theme` | `'light'` | Colour theme: `'light'` or `'constellation'` (see [Themes](#themes)). Setting it applies the theme's `style` colours; colours given in the same patch win. |
| `logging` | `true` | Master switch for console output: every warning (refusals, unknown uids, host handlers that threw/rejected, malformed input) and the `logEvents` trace. `false` silences all of it except the one-line startup banner (`[Nodino] v<version> started`) that `create()` always prints. |
| `logEvents` | `false` | Traces every control press, public method call, lifecycle transition and host callback invocation to the console. Needs `logging` on too. |
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
| `viewMode` | `'relations'` | `'relations'` (every input edge, both signs — what drives the layout), `'proximity'` (nodes within the proximity radius of each other in the *current* layout — see `proximityRadius`), or `'clusters'` (proximity graph, long edges cut, colored by connected component — parked, not in the toggle, but usable via `updateConfig`). `'proximity'`/`'clusters'` are only offered while the simulation is stopped. |
| `showLabelsToggle` | `true` | The eye button right of the view-mode toggle, flipping `showNodeLabels`. Hiding it leaves `showNodeLabels` as it is — set both to force labels on or off. |
| `showViewModeToggle` | `true` | The Relations/Proximity pill. Also gates the automatic switch to `'proximity'` on convergence — hiding the toggle means the host owns `viewMode` outright. |
| `proximityRadius` | `'auto'` | How the `'proximity'` radius is chosen. `'auto'`: scaled with the node count so each node has about `proximityNeighbors` others within it, at any graph size. `'fixed'`: the absolute radii below. |
| `proximityNeighbors` | `16` | `'auto'` only: the average neighbourhood size aimed at, from 400 nodes up. Smaller graphs ask for proportionally fewer (`× √(n/400)`, and at most a quarter of the other nodes), so they don't look like a mesh. `16` matches the fixed `0.2` at 400 nodes. |
| `proximityMaxDistance` | `0.2` | `'fixed'` only: radius (world units, disk radius = 1) defining the `'proximity'` reading on the plane. |
| `globeProximityMaxDistance` | `0.4` | `'fixed'` only: same, for the globe — a separate field because the sphere's surface area is 4× the disk's, so an equivalent neighborhood is twice the radius. |
| `clusterQuantile` | `0.8` | Quantile of the proximity graph's own edge-length distribution beyond which edges are cut before taking connected components, for `'clusters'`. |

### Chrome visibility (all in `nodino.css`)

| Field | Default | Component |
|---|---|---|
| `showDebugToggle` | `true` | The ⚙ button (top-right) and, with `debug`, the config panel it opens. |
| `showSimControls` | `true` | Reset/Run/Pause/Force bar + state readout (top-right). |
| `showSearch` | `true` | uid search box + autocomplete (top-centre). |
| `searchMaxResults` | `12` | Maximum rows in the search autocomplete list. |
| `showStats` | `true` | Node/edge counts (bottom-right). |
| `showRunTime` | `true` | Accumulated running time (bottom-left). |
| `showProgressBar` | `true` | Convergence-deadline bar (bottom edge). |
| `showPulse` | `true` | Perimeter opacity animation while running — purely cosmetic. |
| `showNodeLabels` | `true` | Node names drawn on the canvas once zoomed in — see [Node labels](#node-labels). Painted, not chrome: needs nothing from `nodino.css`. |

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
| `backgroundColor` | `'#ffffff'` | Fill inside the perimeter while the layout is *not* settled (loaded, running, paused). |
| `outsideBackgroundColor` | `'#ffffff'` | Fill outside the perimeter while the layout is *not* settled (loaded, running, paused). |
| `outsideColor` | `'#f8f8fe'` | Fill outside the perimeter once the layout is settled (eased in/out). |
| `settledBackgroundColor` | `'#ffffff'` | Fill *inside* the perimeter once the layout is settled, in every view — eased in/out together with `outsideColor`. |
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
| `nodeRadiusMax` / `nodeRadiusMin` | `2.5` / `1` | Clamp on the scaled radius, screen px. |
| `highlightColor` / `highlightBorderColor` | `'#ffffff'` / `'#000000'` | Hovered/pinned node mark. |
| `highlightBorderWidth` | `1.5` | | |
| `highlightRadius` | `5` | Scales with the node's own current radius. |

### `style.*` — labels

| Field | Default | Description |
|---|---|---|
| `labelMinZoom` | `1` | Multiple of the fit-to-view zoom below which no label is drawn. At `1`, the default view is labelled and zooming out past it hides every label. |
| `labelMaxCount` | `200` | Most labels drawn at once. `0` hides them. |
| `labelFontSize` | `11` | Screen px, fixed regardless of zoom. |
| `labelFontFamily` | `'sans-serif'` | Any CSS font-family list. |
| `labelFontWeight` | `'normal'` | Any CSS font-weight (`'normal'`, `'bold'`, `600`…). |
| `labelColor` | `'#000000'` | Text color (6-digit hex). |
| `labelPosition` | `'right'` | Side of the node the label sits on: `'right'`, `'left'`, `'top'` or `'bottom'` (the last two centred on the node). |
| `labelHaloColor` | `'255,255,255'` | Outline under the text, keeping it readable over edges (RGB triplet string). |
| `labelHaloAlpha` | `0.8` | Halo opacity: `1` blanks the edges under a label, lower lets them show through. |
| `labelHaloWidth` | `3` | Screen px the halo extends around the letters. `0` removes it. |
| `labelPadding` | `4` | Screen px of clear space kept around each label. |

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
| `globeGraticuleAlpha` | `0.1` | |
| `globeGraticuleWidth` | `1` | |
| `globeLabelMinDepth` | `0.3` | Labels only for nodes this far towards the viewer (`0` = rim, `1` = facing). |

## UI features (chrome)

Everything below is optional (each behind its own `show*` flag above) and requires `nodino.css`. All of it is built and torn down through `updateConfig()` — hiding a flag removes the component's DOM, not just its visibility.

- **Simulation controls** (`showSimControls`, top-right): Reset / Run / Pause / Force buttons plus a live state-name readout, driving the [lifecycle](#lifecycle) directly. Illegal transitions grey their button out rather than hiding it.
- **Debug/config panel** (`showDebugToggle` + `debug`, top-right): a live tweak panel over every `physics.*`/`style.*` field and the proximity radii, for development. Not meant for a shipped embedding's normal chrome — it edits `config` directly through `updateConfig()`. Its last group, **Themes**, applies a colour theme to the graph (Light (Default), Constellation) — the same as setting those `style` colours yourself. **Copy Config (JSON)**, at the foot of the panel, copies the current config as JSON — only the fields that differ from the defaults (a theme as `theme` plus any colour changed from it; `debug` left out) — ready to pass as `create()`'s `config`, to `updateConfig()` or as `load()`'s `config`. Where the clipboard is unavailable (not https/localhost, or refused), the JSON is shown in a box under the button to copy by hand.
- **Geometry toggle** (`showGeometryToggle`, top-centre): switches `config.geometry` between `'plane'` (2D) and `'globe'` (3D). Icon + label on each button.
- **View-mode toggle** (`showViewModeToggle`, top-centre): switches `config.viewMode` between Relations and Proximity. Proximity is greyed out while the simulation is running (it reads a settled layout) and the widget switches to it automatically on convergence, unless this toggle is hidden.
- **Labels toggle** (`showLabelsToggle`, top-centre, right of the view-mode toggle): an eye button that turns the [node labels](#node-labels) on and off (`config.showNodeLabels`). Open eye = on, struck-through eye = off.
- **Search** (`showSearch`, top-centre): a uid text box with an autocomplete list (prefix matches first, then substring, capped at `searchMaxResults`, default 12). A row hovers on cursor-over and pins on click — the same two gestures a node itself answers. ↓/↑ walk the list (and open it, even on an empty box: then it lists the first uids, up to the same cap), Enter pins, Esc closes. When the text is exactly a uid, or only one row is left, that row is selected automatically (while typing and on focus), so Enter pins it straight away. On the globe, picking a node that lies on the far side (click or Enter, not hover) turns the globe to bring it under the centre of the view; pan and zoom are unchanged, and a rotation drag cancels the turn.
- **Detail panel** (always on if `onNodeHover`/`onNodePin` are used — not behind a flag): a hover card that follows the cursor (click-through) and a pinned card that follows its node across pan/zoom/rotation/running layout (`pointer-events: auto`, so host-injected buttons/links are clickable). One click moves the pin; `Esc`, a click on the background, or a click on the pinned node again releases it.
- **Stats readout** (`showStats`, bottom-right): `"N nodes · M edges"`, or `"M of K edges"` when `maxEdgesPerNode` sparsified the input.
- **Run-time readout** (`showRunTime`, bottom-left): accumulated running seconds + total step count.
- **Progress bar** (`showProgressBar`, bottom edge): tracks whichever convergence budget (seconds/frames) is further along. Visible only in `running`/`running_paused`.
- **Node labels** (`showNodeLabels`) — <a id="node-labels"></a>node names drawn on the canvas next to their nodes, without hovering. Shown only while the layout is not stepping and once zoom reaches `style.labelMinZoom`. Nodes are tried in priority order (`nodePriority`, or node strength by default) and a label is drawn only if it doesn't overlap one already placed, so zooming in progressively uncovers more names. The hovered and pinned nodes show no label (their card already names them); the rest stay where they were. On the globe, only the near side is labelled (`globeLabelMinDepth`). Text comes from `nodeLabel`, or the uid.
- **Perimeter pulse** (`showPulse`): the boundary circle's opacity itself communicates state — flat while idle, pulsing while running, faint once settled. Purely cosmetic; nothing reads it back.

## Interaction (mouse / touch)

All of it works identically with mouse or touch (Pointer Events, `touch-action: none`):

| Gesture | Mouse | Touch |
|---|---|---|
| Pan | Drag background (primary button) or middle-drag; on the globe, middle-drag or Shift-drag (primary drag rotates) | One-finger drag; on the globe, two-finger drag |
| Zoom | Wheel, or two-finger pinch | Two-finger pinch |
| Rotate (globe only) | Primary drag | One-finger drag |
| Hover | Cursor over a node | — (no touch equivalent; a touch drag would open the panel under the finger doing the panning) |
| Pin / unpin | Click a node / click background, `Esc`, or click the pinned node again | Tap a node / tap background, tap the pinned node again |

Zoom is clamped to `[0.25×, 250×]` of the fit-to-view level. Pan is bounded to the graph's own extent plus a margin proportional to the current viewport — the graph can be pushed to the edge of view and a little past it, never off it entirely.

## Security

- **Dataset strings are rendered as text.** Uids (card titles, search list) and labels (canvas) are never parsed as HTML.
- **Card content is not sanitized.** A string returned by `onNodeHover`/`onNodePin` is inserted with `innerHTML`, as-is — that is what lets you put any markup in a card. If any part of it comes from a source you don't control, escape it (or sanitize it with a library such as DOMPurify), or write it into `body` with `textContent` instead:

  ```js
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  onNodeHover: function (node, body) {
    return '<b>' + escapeHtml(node.uid) + '</b><br>' + escapeHtml(node.m.description);
  }
  ```
- **No network, no storage, no `eval`.** Nodino makes no requests and keeps no data outside the page.

### Content-Security-Policy

| Directive | Needs | Why |
|---|---|---|
| `script-src` | the origin serving `nodino.js` | — no `'unsafe-eval'` needed |
| `style-src` | the origin serving `nodino.css` | — no `'unsafe-inline'` needed (Nodino sets styles through the CSSOM only) |
| `worker-src` | `blob:` *(optional)* | Keeps a running simulation at full speed while its tab is hidden. Without it Nodino falls back to a timer: a run in a background tab slows down, nothing else changes (same final layout). |

[Trusted Types](https://developer.mozilla.org/en-US/docs/Web/API/Trusted_Types_API) (`require-trusted-types-for 'script'`) are not supported.

## Accessibility

The chrome uses native buttons and inputs with accessible names, toggle states (`aria-pressed`), a combobox for the search box and a status region for the simulation state — it can be used by keyboard and screen reader. The graph canvas itself is visual only and has no text alternative; if your users need the data in an accessible form, provide it alongside (e.g. a list or table of nodes).
