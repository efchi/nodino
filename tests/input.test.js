// What load() accepts and what it makes of it ([F Data.1], [F Data.2]):
// malformed tuples, implicit and duplicate nodes, out-of-range weights and
// positions, empty and one-node graphs, and the warnings each one earns.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, frames, untilSettled, warnings, allFinite } = require('./helpers/dom');

for (const [name, Nodino] of builds) {
  describe('input — ' + name, () => {
    it('skips malformed edge tuples and self-loops', () => {
      const nodino = createInstance(Nodino);
      nodino.load({
        edges: [
          ['a', 'b', 0.5],
          ['a', 'b'],              // no weight
          'not-an-array',
          [null, 'c', 0.5],        // null endpoint
          ['d', 'd', 0.9],         // self-loop
          ['b', 'c', 0.3]
        ]
      });
      const stats = nodino.getStats();
      assert.equal(stats.inputEdgeCount, 2);
      assert.deepEqual(Object.keys(nodino.getPositions()).sort(), ['a', 'b', 'c']);
      nodino.destroy();
    });

    it('an edge declares its endpoints; `nodes` adds metadata and isolated nodes', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ nodes: { a: { m: { k: 1 } }, lonely: {} }, edges: [['a', 'b', 0.5]] });
      assert.deepEqual(Object.keys(nodino.getPositions()).sort(), ['a', 'b', 'lonely']);
      nodino.destroy();
    });

    it('uids are strings: numeric uids name the same nodes as their strings', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ edges: [[1, 2, 0.5], ['2', '3', 0.5]] });
      assert.deepEqual(Object.keys(nodino.getPositions()).sort(), ['1', '2', '3']);
      assert.equal(nodino.pin(2), true);
      assert.equal(nodino.getPinned(), '2');
      nodino.destroy();
    });

    it('non-finite and out-of-range weights are clamped, never break the layout', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ edges: [['a', 'b', NaN], ['b', 'c', 7], ['c', 'd', -9], ['d', 'a', 'x']] });
      nodino.start();
      frames(100);
      assert.ok(allFinite(nodino));
      nodino.destroy();
    });

    // Regression: edges were summed in input order, so the same graph listed
    // differently drifted apart — 65px after 1500 steps on 200 nodes.
    it('the layout depends on the edge set, not on how it is listed', () => {
      const edges = [['a', 'b', 0.5], ['b', 'c', 0.4], ['c', 'd', 0.3], ['d', 'a', -0.2], ['a', 'c', 0.1],
        ['b', 'a', -0.3], ['e', 'a', 0.6], ['c', 'e', 0.2]];
      const run = (list) => {
        const nodino = createInstance(Nodino);
        nodino.load({ edges: list });
        nodino.start();
        frames(60);
        const p = nodino.getPositions();
        nodino.destroy();
        return p;
      };
      const flipped = edges.map((e) => [e[1], e[0], e[2]]);
      assert.deepEqual(run(edges), run(edges.slice().reverse()));
      assert.deepEqual(run(edges), run(flipped));
    });

    it('an empty graph is empty, and refuses to start', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ edges: [] });
      assert.equal(nodino.getStats().state, 'empty');
      assert.equal(nodino.getStats().nodeCount, 0);
      warnings.length = 0;
      nodino.start();
      assert.equal(nodino.getStats().state, 'empty');
      assert.equal(warnings.length, 1);
      nodino.destroy();
    });

    it('a one-node graph loads, runs and settles without a NaN', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ nodes: { solo: {} }, edges: [] });
      assert.equal(nodino.getStats().state, 'loaded');
      nodino.start();
      assert.ok(untilSettled(nodino));
      assert.ok(allFinite(nodino));
      nodino.destroy();
    });

    it('positions: unknown uids warn, out-of-range ones are clamped into the disk', () => {
      const nodino = createInstance(Nodino);
      warnings.length = 0;
      nodino.load({ edges: [['a', 'b', 0.5]], positions: { a: { x: 5, y: -5 }, ghost: { x: 0, y: 0 } } });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /ghost/);
      const a = nodino.getPositions().a;
      assert.ok(a.x <= 1 && a.y >= -1);
      nodino.destroy();
    });

    it('a partial positions set is a seed: the graph opens loaded, not settled', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ edges: [['a', 'b', 0.5], ['b', 'c', 0.5]], positions: { a: { x: 0.1, y: 0.2 } } });
      assert.equal(nodino.getStats().state, 'loaded');
      assert.deepEqual(nodino.getPositions().a, { x: 0.1, y: 0.2 });
      nodino.destroy();
    });

    it('an invalid maxFrames is ignored with a warning', () => {
      const nodino = createInstance(Nodino);
      warnings.length = 0;
      nodino.load({ edges: [['a', 'b', 0.5]], maxFrames: -3 });
      assert.equal(nodino.getStats().maxFrames, 0);
      assert.equal(warnings.length, 1);
      nodino.destroy();
    });

    it('maxEdgesPerNode keeps each node\'s strongest edges only', () => {
      const edges = [];
      for (let i = 0; i < 20; i++) for (let j = i + 1; j < 20; j++) edges.push(['n' + i, 'n' + j, ((i * j) % 7 - 3) / 3]);
      const nodino = createInstance(Nodino, { config: { maxEdgesPerNode: 3 } });
      nodino.load({ edges });
      const stats = nodino.getStats();
      assert.equal(stats.inputEdgeCount, edges.length);
      assert.ok(stats.edgeCount < edges.length);
      assert.ok(stats.edgeCount <= 20 * 3);
      nodino.destroy();
    });

    it('pin()/hover() on an unknown uid return false with a warning', () => {
      const nodino = createInstance(Nodino);
      nodino.load({ edges: [['a', 'b', 0.5]] });
      warnings.length = 0;
      assert.equal(nodino.pin('nope'), false);
      assert.equal(nodino.hover('nope'), false);
      assert.equal(warnings.length, 2);
      assert.equal(nodino.unpin(), false);
      assert.equal(nodino.unhover(), false);
      nodino.destroy();
    });

    it('a handler that throws is contained and warned about', () => {
      const nodino = createInstance(Nodino, { config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 5 } } });
      nodino.load({ edges: [['a', 'b', 0.5], ['b', 'c', 0.5]] }, {
        nodeLabel: () => { throw new Error('label'); },
        onSettle: () => { throw new Error('settle'); }
      });
      warnings.length = 0;
      nodino.start();
      assert.ok(untilSettled(nodino));
      assert.ok(warnings.some((w) => /onSettle threw/.test(w)));
      nodino.destroy();
    });
  });
}
