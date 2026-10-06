# Changelog

All notable changes to Nodino are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

For how the library behaves *now*, read [`API-DOCS.md`](API-DOCS.md). This file only records what changed between versions.

## 2.4.12 — 2026-10-03

### Added

- `update()` to add and remove nodes and edges on a loaded graph, also while the simulation runs.
- Node labels on the canvas (`showNodeLabels`, `showLabelsToggle`), with `nodeLabel`/`nodePriority` in `load()` and their own `style` fields, weight and position included.
- Node events (`onNodeClick`, `onHoverChange`, `onPinChange`) with `preventDefault()` to replace Nodino's own reaction, plus `getPinned()`/`getHovered()`.
- `onNodeHover`/`onNodePin` receive the card element, to style a card per node.
- Globe: a search pick on a hidden node rotates it into view; `pin(uid, { autoRotate: true })` does the same from code.
- `load()` option `settled: false`, to reopen a layout saved mid-run as paused.
- `logging` flag to silence the console, plus a startup line with the version.
- `Nodino.defaults`: the default config, read-only.
- Debug panel: **Copy Config (JSON)**, the current config as a patch onto the defaults, ready to paste into `create()`, `updateConfig()` or `load()`.
- New config: `searchMaxResults`, `settledBackgroundColor`, `outsideBackgroundColor`.
- Colour themes for the graph and the menus: `config.theme` (`'light'`, `'constellation'` — a dark night-sky theme), `Nodino.themes`, and a Themes group in the debug panel. Every menu colour is now a CSS custom property.
- ES module and minified builds (`nodino.mjs`, `nodino.min.js`, `nodino.min.mjs`, `nodino.min.css`).
- Security and accessibility sections in the docs.
- Automated test suite (`npm test`): lifecycle, `update()`, input handling and determinism, on both the readable and the minified build.
- Demo: presets, loaded on start — Pokémon (1st and 1st + 2nd generation), the artists most listened to on Spotify (top 250 and 1000), the 500 most read Wikipedia articles, and 500 world cities placed by distance alone.
- Demo: `?preset=<id>` opens a single preset with a reduced panel; presets can bring their own config.
- Demo: Light | Dark theme toggle, a hint on Run until the simulation starts, a seed for random generation, Add Node / Remove Node buttons.

### Changed

- The proximity radius scales with the graph size by default (`proximityRadius: 'auto'`, `proximityNeighbors`); `'fixed'` keeps the old absolute radius.
- Lighter, unified UI for all menus, themable through CSS variables.
- Defaults: `style.nodeRadiusMax` from `5` to `2.5`, `style.globeGraticuleAlpha` from `0.16` to `0.1`.
- UI/UX improvements: search keyboard navigation and auto-selection, middle-drag pan in 2D, screen-reader support, demo panel as an accordion.

### Removed

- `logo.svg` from the npm package.

### Fixed

- The layout no longer depends on the order the edges are listed in. Re-running a graph gives a slightly different result than earlier versions; cached layouts are unaffected.
- TypeScript declarations match the module format under every resolution mode.
- `pin()`, `unpin()`, `hover()` and `unhover()` are refused on a destroyed instance.
- Chrome buttons no longer submit an enclosing `<form>`.
- A `load()` changing `geometry` updates the 2D/3D toggle.
- Minor UI/UX fixes.

## 2.0.0 — 2026-09-21

Baseline release: the first version published on GitHub and npm (`@efchi/nodino`).

- Deterministic force-directed layout (stress majorization), with no `Math.random()` in the library.
- Two geometries, `plane` (unit disk) and `globe` (sphere surface), stepped together.
- Readings: `relations` (input edges) and `proximity` (neighbourhood in the layout).
- Symmetric kNN sparsification (`maxEdgesPerNode`).
- Lifecycle state machine: Run, Pause, Force and Reset. Convergence budgets in seconds and in steps, plus `onSettle`/`onPause` for caching layouts.
- Canvas interaction: pan, zoom, rotation on the globe, hover and click-to-pin cards (`onNodeHover`/`onNodePin`), uid search with autocomplete.
- Optional chrome in `nodino.css`, every component behind its own `show*` flag. Responsive tiers at 1200 px and 480 px.
- Hand-written TypeScript declarations (`nodino.d.ts`).
