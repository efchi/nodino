# CLAUDE.md — Nodino

Guidance for AI agents working on, extending, or embedding **Nodino** — a deterministic, dependency-free force-directed graph viewer in a single JS file plus an optional CSS file for its chrome.

## Orientation

| File | Read it for |
|---|---|
| [`nodino.dox.md`](nodino.dox.md) | **The authoritative as-is spec.** Every behavior, why it works that way, and the tradeoff behind each decision. Read the relevant section before touching physics, rendering, the API, or config — this is the source of truth, not the code's comments and not this file. |
| [`API-DOCS.md`](API-DOCS.md) | The public interface: every exposed method, config field, callback, and UI feature, as a reference — no rationale, just signatures and defaults. What a *host* needs. |
| `nodino.js` | The implementation. One IIFE, no build step, no dependencies. Heavily commented — most comments explain *why*, cross-referenced to dox IDs like `[D Render.2]`. |
| `nodino.css` | Optional chrome styling (debug panel, toggles, search, detail panel, readouts, progress bar). The canvas itself needs nothing from it. |
| `nodino.d.ts` | Hand-written TypeScript declarations for the npm package (`@efchi/nodino`). A third copy of the public surface — see below. |
| `package.json` | npm manifest. `files` is a whitelist; nothing else in the folder is published. |
| `demo.html` | Exerciser — every data source (random/paste/file) plus the debug panel. |
| `README.md` | Human-facing project overview. |

## Hard invariants

These are load-bearing, repeatedly-reaffirmed constraints. Breaking one is a regression even if the immediate change works.

1. **`nodino.js` never calls `Math.random()`.** The same input (data + config) must produce the same layout on every machine, every run. Any randomness a *host* wants (e.g. generating a random demo graph) belongs in the host page, not the library. See dox § Determinism.
2. **Every change that touches positions, the spatial index, the physics step, or the draw loop has to be considered for *both* geometries** — `config.geometry: 'plane'` and `'globe'` each have their own layout arrays, spatial index, and engine instance, stepped together regardless of which is on screen. The giveaway that one was missed: a change that works flat and does nothing (or throws) on the globe, or vice versa. See dox § Geometry.
3. **Every visible chrome piece is config-gated and built/destroyed through the same pattern**, not just hidden with CSS. A new UI component needs a `show*` boolean in `DEFAULT_CONFIG`, and must be constructed and torn down via the existing `syncComponent`-style flow in `create()`/`updateConfig()` — a flag that only toggles `display` leaves the component's state alive and its listeners attached. (`showProgressBar` used to be the one exception to this; it no longer is — see dox.)
4. **`nodino.dox.md` is updated in the same change as any behavior change** to `nodino.js`/`nodino.css`/`demo.html` — not deferred. It is a compact as-is spec with no changelog or version history by design: edit the relevant assertion in place to describe the new reality, don't append a note. Pure CSS/cosmetic changes (spacing, color, non-behavioral layout) don't require a dox edit.
5. **No new runtime dependency, no build step.** Nodino ships as two static files a `<script>`/`<link>` tag can load directly. If a change seems to need a library, that's a signal to reconsider the approach, not to add a bundler.
6. **Config is deep-merged, not replaced.** `Nodino.create()`'s `options.config`, `load()`'s `loadOptions.config`, and `updateConfig()`'s `partial` are all partial patches onto the live config object — never assume a field not mentioned in a patch reverts to its default.
7. **Loading `nodino.js` must not touch the DOM.** Only `create()` (and what it builds) may reference `document`/`window`; the top level of the IIFE must stay free of them, so `require`/`import` is safe server-side. The file exports through `module.exports` under CommonJS and `window.Nodino` otherwise — keep both paths working. See dox § Architecture ([F Arch.2]).

## Extending the library

**Adding a config field:** add it to `DEFAULT_CONFIG` in `nodino.js` with a default value and a comment explaining *why* that default (not just what it does — the existing comments are the style to match); document it in `nodino.dox.md`; add it to the relevant table in `API-DOCS.md` and to `NodinoConfig` (or its `physics`/`style` part) in `nodino.d.ts`; if it's a tunable meant for development-time iteration (not a one-time embedding choice), expose it in the debug panel (`createDebugPanel()`) too.

**Changing the public API** (a method, a callback payload, a data shape): update `API-DOCS.md` and `nodino.d.ts` together with the code.

**Adding a UI/chrome component:** follow invariant 3 above. Give it a `show*` flag, a `nodino-<name>` CSS class in `nodino.css` matching the existing pill/chrome visual language (shared `--nodino-chrome-height`, same background/radius/padding as its siblings), and a dox entry. Check whether it needs to exist on both geometries (invariant 2) and whether it needs a mobile/responsive treatment (`nodino.css`'s two `@media` tiers, appended after the desktop rules so they only *add* behavior below their thresholds).

**Adding a data-driven reading (a new `viewMode`, say):** look at how `'proximity'`/`'clusters'` are built — computed once on entering the view (not per frame, since it's only offered while the layout is stopped), with its own cache-invalidation rule in `updateConfig()`. Read dox § View Modes before adding a fourth.

**Embedding Nodino in a host app:** this is what `API-DOCS.md` and `demo.html` are for — read those, not the library source, unless the interface genuinely doesn't cover what's needed.

## Testing & verification

- **No automated browser testing in this project.** The user tests manually. After a change, state clearly what to check by hand (generate → layout converges → pan/zoom/hover/pin → import JSON → debug panel → both geometries → both desktop and the responsive breakpoints) rather than claiming it works.
- **Syntax check:** `node --check nodino.js` (Node is available on the dev machine). For `demo.html`'s inline scripts, extract and run each `<script>` block through `new Function(source)`.
- **Module load check:** `node -e "console.log(typeof require('./nodino.js').create)"` must print `function` — this is the invariant-7 check (no DOM access at load). Before an npm release, `npm pack --dry-run` shows what would be published.
- There is no test suite and no linter configured. Correctness is verified by reading the dox's stated behavior against the change, and by hand in a browser.

## Style

Match the codebase's existing comment style: comments explain *why* a decision was made (a constraint, a rejected alternative, an incident it fixes), cross-referenced to a dox ID in brackets (`[D Globe.9]`, `[F Interact.3]`) where one exists. Comments that only restate what the code already says plainly are not this project's style — omit them.
