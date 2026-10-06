// The lifecycle state machine ([F State.1], [D State.1]): every state
// reached the way a user or host reaches it, every verb tried from every
// state — legal ones land where the table says, refused ones warn and change
// nothing — plus the transitions the engine makes on its own (convergence,
// both budgets) and the callbacks that report them.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, frames, untilSettled, testGraph, ringGraph, warnings } = require('./helpers/dom');

// The transition table, as documented (API-DOCS.md § Lifecycle): verb ->
// state -> next state. A state missing from a verb's map refuses it.
const TABLE = {
  start: { loaded: 'running', running_paused: 'running' },
  pause: { running: 'running_paused', forced: 'forced_paused' },
  forceContinue: { settled: 'forced', forced_paused: 'forced' },
  restart: {
    running: 'loaded', running_paused: 'loaded', settled: 'loaded',
    forced: 'loaded', forced_paused: 'loaded', forced_settled: 'loaded'
  }
};
const STATES = ['empty', 'loaded', 'running', 'running_paused', 'settled',
  'forced', 'forced_paused', 'forced_settled', 'destroyed'];

// A fresh instance driven into `target` by public calls only. Budgets off,
// so every convergence is organic — the ring converges, plain and forced.
function instanceIn(Nodino, target, options) {
  const nodino = createInstance(Nodino, Object.assign({
    config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 0 } }
  }, options));
  const go = (state) => {
    switch (state) {
      case 'empty': return;
      case 'loaded': nodino.load(ringGraph()); return;
      case 'running': go('loaded'); nodino.start(); frames(3); return;
      case 'running_paused': go('running'); nodino.pause(); return;
      case 'settled': go('running'); assert.ok(untilSettled(nodino)); return;
      case 'forced': go('settled'); nodino.forceContinue(); frames(2); return;
      case 'forced_paused': go('forced'); nodino.pause(); return;
      case 'forced_settled': go('forced'); assert.ok(untilSettled(nodino)); return;
      case 'destroyed': go('loaded'); nodino.destroy(); return;
    }
  };
  go(target);
  assert.equal(nodino.getStats().state, target, 'setup reached ' + target);
  return nodino;
}

for (const [name, Nodino] of builds) {
  describe('state machine — ' + name, () => {
    describe('every verb from every state', () => {
      for (const from of STATES) {
        for (const verb of Object.keys(TABLE)) {
          const to = TABLE[verb][from];
          it(verb + '() in ' + from + ' -> ' + (to || 'refused'), () => {
            const nodino = instanceIn(Nodino, from);
            warnings.length = 0;
            const result = nodino[verb]();
            assert.equal(result, undefined, 'lifecycle verbs return nothing');
            if (to) {
              assert.equal(nodino.getStats().state, to);
              assert.equal(warnings.length, 0);
            } else {
              assert.equal(nodino.getStats().state, from, 'refusal changes nothing');
              assert.equal(warnings.length, 1, 'refusal warns once');
              assert.match(warnings[0], new RegExp(verb + '\\(\\) ignored'));
            }
            if (from !== 'destroyed') nodino.destroy();
          });
        }
      }
    });

    it('load() lands on loaded from every live state, and empty for no nodes', () => {
      for (const from of STATES.filter((s) => s !== 'destroyed')) {
        const nodino = instanceIn(Nodino, from);
        nodino.load(testGraph(10));
        assert.equal(nodino.getStats().state, 'loaded', 'from ' + from);
        nodino.load({ edges: [] });
        assert.equal(nodino.getStats().state, 'empty', 'empty data from ' + from);
        nodino.destroy();
      }
    });

    it('destroyed refuses load, update, updateConfig and a second destroy', () => {
      const nodino = instanceIn(Nodino, 'destroyed');
      warnings.length = 0;
      nodino.load(testGraph(5));
      nodino.update({ addNodes: { x: {} } });
      nodino.updateConfig({ showSearch: false });
      nodino.destroy();
      assert.equal(nodino.getStats().state, 'destroyed');
      assert.equal(warnings.length, 4);
    });

    // Regression: these used to run on the torn-down instance and return true.
    it('destroyed refuses the node verbs (false + warning), getters still answer', () => {
      const nodino = instanceIn(Nodino, 'destroyed');
      warnings.length = 0;
      assert.equal(nodino.pin('r1'), false);
      assert.equal(nodino.unpin(), false);
      assert.equal(nodino.hover('r1'), false);
      assert.equal(nodino.unhover(), false);
      assert.equal(warnings.length, 4);
      assert.equal(nodino.getStats().state, 'destroyed');
      assert.equal(nodino.getPinned(), null);
      assert.equal(typeof nodino.getPositions(), 'object');
    });

    it('the canonical sequence load -> start -> pause -> start -> restart, reported in order', () => {
      const seen = [];
      const nodino = createInstance(Nodino, { onStateChange: (s) => seen.push(s) });
      nodino.load(testGraph(30));
      nodino.start();
      frames(5);
      nodino.pause();
      nodino.start();
      frames(5);
      nodino.restart();
      assert.deepEqual(seen, ['loaded', 'running', 'running_paused', 'running', 'loaded']);
      assert.equal(nodino.getStats().frames, 0, 'restart returns to frame zero');
      nodino.destroy();
    });

    it('load() reports itself even when it lands on the state it started from', () => {
      const seen = [];
      const nodino = createInstance(Nodino, { onStateChange: (s) => seen.push(s) });
      nodino.load(testGraph(10));
      nodino.load(testGraph(12));
      assert.deepEqual(seen, ['loaded', 'loaded']);
      nodino.destroy();
    });

    it('a paused run does not step', () => {
      const nodino = instanceIn(Nodino, 'running_paused');
      const before = nodino.getPositions();
      const frameCount = nodino.getStats().frames;
      frames(20);
      assert.deepEqual(nodino.getPositions(), before);
      assert.equal(nodino.getStats().frames, frameCount);
      nodino.destroy();
    });

    describe('engine-driven endings', () => {
      function endingOf(physics) {
        const results = [];
        const nodino = createInstance(Nodino, { config: { physics } });
        nodino.load(ringGraph(), { onSettle: (r) => results.push(r) });
        nodino.start();
        untilSettled(nodino, 20000);
        const stats = nodino.getStats();
        nodino.destroy();
        return { results, stats };
      }

      it('organic convergence -> settled, reason "converged", onSettle once', () => {
        const { results, stats } = endingOf({ maxConvergenceSeconds: 0, maxConvergenceFrames: 0 });
        assert.equal(stats.state, 'settled');
        assert.equal(results.length, 1);
        assert.equal(results[0].reason, 'converged');
        assert.equal(results[0].state, 'settled');
        assert.equal(results[0].frames, stats.frames);
        assert.equal(typeof results[0].hash, 'string');
      });

      it('step budget -> settled after exactly maxConvergenceFrames steps, reason "capped"', () => {
        const { results, stats } = endingOf({ maxConvergenceSeconds: 0, maxConvergenceFrames: 7 });
        assert.equal(stats.state, 'settled');
        assert.equal(results[0].reason, 'capped');
        assert.equal(results[0].frames, 7);
      });

      it('time budget -> settled, reason "timeout"', () => {
        const { results, stats } = endingOf({ maxConvergenceSeconds: 1e-9, maxConvergenceFrames: 0 });
        assert.equal(stats.state, 'settled');
        assert.equal(results[0].reason, 'timeout');
      });

      it('a forced run waives the budgets and ends in forced_settled, reason "converged"', () => {
        const results = [];
        const nodino = createInstance(Nodino, { config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 7 } } });
        nodino.load(ringGraph(), { onSettle: (r) => results.push(r) });
        nodino.start();
        untilSettled(nodino);
        assert.equal(results[0].reason, 'capped');
        nodino.forceContinue();
        frames(20);
        assert.equal(nodino.getStats().state, 'forced', 'past the 7-step budget, still running');
        assert.ok(untilSettled(nodino, 20000));
        assert.equal(nodino.getStats().state, 'forced_settled');
        const last = results[results.length - 1];
        assert.equal(last.state, 'forced_settled');
        assert.equal(last.reason, 'converged');
        assert.ok(last.frames > 7);
        nodino.destroy();
      });
    });

    it('pause() offers the layout through onPause, reason "paused"', () => {
      const results = [];
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(30), { onPause: (r) => results.push(r) });
      nodino.start();
      frames(10);
      nodino.pause();
      assert.equal(results.length, 1);
      assert.equal(results[0].reason, 'paused');
      assert.equal(results[0].state, 'running_paused');
      assert.equal(results[0].frames, 10);
      nodino.destroy();
    });

    it('the record (maxFrames) is raised on convergence and survives restart()', () => {
      const nodino = createInstance(Nodino, { config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 0 } } });
      nodino.load(ringGraph());
      nodino.start();
      untilSettled(nodino);
      const frames1 = nodino.getStats().frames;
      assert.equal(nodino.getStats().maxFrames, frames1);
      nodino.restart();
      assert.equal(nodino.getStats().maxFrames, frames1);
      assert.equal(nodino.getStats().frames, 0);
      nodino.destroy();
    });

    it('a complete positions set opens settled, with its frames, and never fires onSettle', () => {
      const source = createInstance(Nodino, { config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 0 } } });
      const graph = ringGraph();
      source.load(graph);
      source.start();
      untilSettled(source);
      const positions = source.getPositions();
      const globePositions = source.getGlobePositions();
      const steps = source.getStats().frames;
      source.destroy();

      const settles = [];
      const nodino = createInstance(Nodino);
      nodino.load(Object.assign({}, graph, { positions, globePositions, maxFrames: steps }), {
        onSettle: (r) => settles.push(r)
      });
      frames(5);
      const stats = nodino.getStats();
      assert.equal(stats.state, 'settled');
      assert.equal(stats.frames, steps);
      assert.equal(stats.maxFrames, steps);
      assert.equal(settles.length, 0);
      nodino.destroy();
    });

    it('a complete layout saved mid-run (settled: false) reopens paused, and Run resumes it', () => {
      const source = createInstance(Nodino);
      const graph = ringGraph();
      source.load(graph);
      source.start();
      frames(20);
      source.pause();
      const saved = Object.assign({}, graph, {
        positions: source.getPositions(),
        globePositions: source.getGlobePositions(),
        maxFrames: source.getStats().frames,
        settled: source.getStats().settled
      });
      source.destroy();
      assert.equal(saved.settled, false);

      const nodino = createInstance(Nodino);
      nodino.load(saved);
      assert.equal(nodino.getStats().state, 'running_paused');
      assert.equal(nodino.getStats().frames, 20);
      assert.deepEqual(nodino.getPositions(), saved.positions);
      warnings.length = 0;
      nodino.forceContinue();
      assert.equal(warnings.length, 1, 'Force is not offered from a pause');
      nodino.start();
      frames(5);
      assert.equal(nodino.getStats().state, 'running');
      assert.equal(nodino.getStats().frames, 25);
      nodino.destroy();
    });

    it('settled absent or true keeps opening a complete layout settled', () => {
      const graph = ringGraph();
      const source = createInstance(Nodino);
      source.load(graph);
      const positions = source.getPositions();
      source.destroy();
      for (const extra of [{}, { settled: true }]) {
        const nodino = createInstance(Nodino);
        nodino.load(Object.assign({}, graph, { positions }, extra));
        assert.equal(nodino.getStats().state, 'settled');
        nodino.destroy();
      }
    });

    it('a geometry switch never changes the state', () => {
      for (const from of ['loaded', 'running', 'running_paused', 'settled', 'forced']) {
        const nodino = instanceIn(Nodino, from);
        nodino.updateConfig({ geometry: 'plane' });
        assert.equal(nodino.getStats().state, from);
        nodino.updateConfig({ geometry: 'globe' });
        assert.equal(nodino.getStats().state, from);
        nodino.destroy();
      }
    });

    it('a maxEdgesPerNode change keeps a running graph running and drops a forced run to plain', () => {
      const running = instanceIn(Nodino, 'running');
      running.updateConfig({ maxEdgesPerNode: 5 });
      assert.equal(running.getStats().state, 'running');
      running.destroy();
      const forced = instanceIn(Nodino, 'forced');
      forced.updateConfig({ maxEdgesPerNode: 5 });
      assert.equal(forced.getStats().state, 'running');
      forced.destroy();
      const settled = instanceIn(Nodino, 'settled');
      settled.updateConfig({ maxEdgesPerNode: 5 });
      assert.equal(settled.getStats().state, 'loaded');
      settled.destroy();
    });
  });
}
