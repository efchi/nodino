// A stub DOM, just enough for create() to run headless in Node: every element
// accepts whatever is set on it and answers what Nodino asks, the canvas
// context swallows every draw call, and requestAnimationFrame queues its
// callbacks for frames() to run by hand. Nothing is rendered — these tests
// exercise the engine, the state machine and the API, not the pixels (the
// project's rule stands: the visual result is checked by hand in a browser).

'use strict';

const path = require('node:path');

// An inline style object where assigning cssText clears every property, as
// in a browser.
function stubStyle() {
  return new Proxy({}, {
    set(target, key, value) {
      if (key === 'cssText') { for (const k of Object.keys(target)) delete target[k]; return true; }
      target[key] = value;
      return true;
    }
  });
}

function stubElement() {
  const store = { style: stubStyle(), children: [], attrs: {}, classes: new Set(), value: '', textContent: '', listeners: {} };
  const proxy = new Proxy({}, {
    get(target, key) {
      if (key === 'className') return [...store.classes].join(' ');
      if (key in store) return store[key];
      switch (key) {
        case 'classList': return {
          add: (c) => store.classes.add(c),
          remove: (c) => store.classes.delete(c),
          toggle: (c, force) => {
            const on = force === undefined ? !store.classes.has(c) : force;
            if (on) store.classes.add(c); else store.classes.delete(c);
          },
          contains: (c) => store.classes.has(c)
        };
        case 'appendChild': return (child) => {
          store.children.push(child);
          try { child.parentElement = proxy; } catch (err) { /* text node */ }
          return child;
        };
        case 'removeChild': return (child) => child;
        // Listeners are recorded, so fire() can drive a control by hand.
        case 'addEventListener': return (type, fn) => { (store.listeners[type] ||= []).push(fn); };
        case 'setAttribute': return (a, v) => { store.attrs[a] = v; };
        case 'getAttribute': return (a) => (a in store.attrs ? store.attrs[a] : null);
        case 'removeAttribute': return (a) => { delete store.attrs[a]; };
        case 'getBoundingClientRect': return () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
        case 'getContext': return () => context;
        case 'offsetWidth': case 'clientWidth': case 'width': return 800;
        case 'offsetHeight': case 'clientHeight': case 'height': return 600;
        case 'querySelectorAll': return () => [];
        case 'parentNode': return null;
        default:
          return typeof key === 'string' && /^(add|remove|set|release|focus|blur|scroll|insert|dispatch)/.test(key)
            ? () => {}
            : undefined;
      }
    },
    set(target, key, value) {
      // className and classList are one attribute, as in a browser.
      if (key === 'className') store.classes = new Set(String(value).split(/\s+/).filter(Boolean));
      else store[key] = value;
      return true;
    }
  });
  return proxy;
}

const context = new Proxy({}, {
  get(target, key) {
    if (key === 'measureText') return () => ({ width: 10 });
    if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
    return () => {};
  },
  set() { return true; }
});

let rafQueue = [];

global.window = global;
global.document = {
  createElement: () => stubElement(),
  createElementNS: () => stubElement(),
  createTextNode: () => stubElement(),
  addEventListener() {},
  removeEventListener() {},
  hidden: false,
  visibilityState: 'visible'
};
global.getComputedStyle = () => ({ position: 'relative' });
global.ResizeObserver = class { observe() {} disconnect() {} };
global.requestAnimationFrame = (f) => { rafQueue.push(f); return 1; };
global.cancelAnimationFrame = () => {};
global.devicePixelRatio = 1;
// No worker: the background ticker falls back to its interval, which these
// tests never wait on — frames() drives the simulation directly.
global.Worker = undefined;

// Warnings are collected rather than printed, so a test can assert on them;
// the startup banner is dropped.
const warnings = [];
console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
console.info = () => {};

// Calls the listeners an element registered for `type`, with a minimal event.
function fire(el, type) {
  for (const fn of el.listeners[type] || []) fn({ type, target: el, preventDefault() {}, stopPropagation() {} });
}

// Runs `n` animation frames — one simulation step each while running.
function frames(n) {
  for (let i = 0; i < n; i++) {
    const queue = rafQueue;
    rafQueue = [];
    queue.forEach((f) => f(performance.now()));
  }
}

// Steps until the layout converges (or `max` frames pass).
function untilSettled(instance, max = 5000) {
  for (let i = 0; i < max && !instance.getStats().settled; i++) frames(1);
  return instance.getStats().settled;
}

// The builds under test: the readable source always, the minified one when
// `npm run build` has produced it.
const root = path.join(__dirname, '..', '..');
const builds = [['nodino.js', require(path.join(root, 'nodino.js'))]];
try {
  builds.push(['nodino.min.js', require(path.join(root, 'nodino.min.js'))]);
} catch (err) { /* not built yet */ }

function createInstance(Nodino, options) {
  const container = stubElement();
  const instance = Nodino.create(container, options);
  // The container, for tests that read the chrome built into it.
  instance.__container = container;
  return instance;
}

// The first element under `root` whose aria-label is `label` — how a test
// reads a debug-panel field (create with `config: { debug: true }`).
function findByLabel(root, label) {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el && el.getAttribute && el.getAttribute('aria-label') === label) return el;
    if (el && el.children) for (const child of el.children) stack.push(child);
  }
  return null;
}

// A deterministic test graph: `n` nodes, edges on a fixed arithmetic pattern.
function testGraph(n = 60) {
  const nodes = {};
  const edges = [];
  for (let i = 0; i < n; i++) nodes['n' + i] = { m: { i } };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if ((i * 7 + j * 13) % 9 === 0) edges.push(['n' + i, 'n' + j, ((i + j) % 5 - 2) / 2]);
    }
  }
  return { nodes, edges };
}

// A ring of `n` nodes joined by one positive weight: small, and one of the
// few shapes that converges organically — in a plain run and a forced one
// alike — within a few hundred steps, so tests can reach 'settled' and
// 'forced_settled' without a budget ending the run for them.
function ringGraph(n = 12, weight = 0.6) {
  const nodes = {};
  const edges = [];
  for (let i = 0; i < n; i++) {
    nodes['r' + i] = {};
    edges.push(['r' + i, 'r' + ((i + 1) % n), weight]);
  }
  return { nodes, edges };
}

function allFinite(instance) {
  const p = Object.values(instance.getPositions());
  const g = Object.values(instance.getGlobePositions());
  return p.every((v) => isFinite(v.x) && isFinite(v.y)) &&
    g.every((v) => isFinite(v.x) && isFinite(v.y) && isFinite(v.z));
}

module.exports = { builds, createInstance, findByLabel, fire, frames, untilSettled, testGraph, ringGraph, allFinite, warnings };
