// update() ([F API.14]): the lifecycle table, carried layout, pin and hover
// across edits, the edge cases, both geometries.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, frames, untilSettled, testGraph, allFinite, warnings } = require('./helpers/dom');

for (const [name, Nodino] of builds) {
  describe('update() — ' + name, () => {
    it('builds a graph on an empty instance and stays stopped', () => {
      const nodino = createInstance(Nodino);
      assert.equal(nodino.update({ addNodes: { a: {}, b: {} }, addEdges: [['a', 'b', 0.5]] }), true);
      assert.equal(nodino.getStats().state, 'loaded');
      assert.equal(nodino.getStats().nodeCount, 2);
      nodino.destroy();
    });

    it('rebuilds a loaded graph and stays loaded', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.update({ addNodes: { x: {} }, addEdges: [['x', 'n1', 0.9]] });
      assert.equal(nodino.getStats().state, 'loaded');
      assert.equal(nodino.getStats().nodeCount, 61);
      nodino.destroy();
    });

    it('keeps running, carries positions and the pin', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      frames(30);
      nodino.pin('n5');
      const before = nodino.getPositions().n10;
      nodino.update({
        addNodes: { x: { m: { k: 1 } } },
        addEdges: [['x', 'n10', 0.8], ['x', 'n11', 0.4]],
        removeNodes: ['n20']
      });
      const positions = nodino.getPositions();
      assert.equal(nodino.getStats().state, 'running');
      assert.deepEqual(positions.n10, before);
      assert.equal(nodino.getPinned(), 'n5');
      assert.ok(!('n20' in positions) && 'x' in positions);
      assert.ok(allFinite(nodino));
      frames(50);
      assert.ok(allFinite(nodino));
      nodino.destroy();
    });

    it('releases the pin of a removed node, not cancelable, source "update"', () => {
      const events = [];
      const nodino = createInstance(Nodino, {
        // Tries to keep the pin through the update — and must fail to.
        onPinChange: (e) => { events.push(e); if (e.source === 'update') e.preventDefault(); }
      });
      nodino.load(testGraph());
      nodino.start();
      frames(5);
      nodino.pin('n5');
      events.length = 0;
      nodino.update({ removeNodes: ['n5'] });
      assert.equal(nodino.getPinned(), null);
      assert.equal(events.length, 1);
      assert.equal(events[0].previous, 'n5');
      assert.equal(events[0].uid, null);
      assert.equal(events[0].source, 'update');
      assert.equal(events[0].cancelable, false);
      nodino.destroy();
    });

    // Regression: update() used to reset the engines' annealing, so the
    // steps after an edit moved a tenth as far, stayed under stopVelocity for
    // stopFrames steps, and the plane froze mid-motion on step 41.
    it('keeps the annealing: steps after an edit move as far as before it', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(80));
      nodino.start();
      frames(200);
      // Mean per-node movement over ten steps. Measured from the tenth step
      // after the edit: the carried velocities mask the drop for the first
      // few, and the drop is what this test is about (0.5x with the old
      // reset, ~1.3x without).
      const meanOver = (steps) => {
        let total = 0;
        for (let s = 0; s < steps; s++) {
          const a = nodino.getPositions();
          frames(1);
          const b = nodino.getPositions();
          let sum = 0, n = 0;
          for (const k in a) if (b[k]) { sum += Math.hypot(b[k].x - a[k].x, b[k].y - a[k].y); n++; }
          total += sum / n;
        }
        return total / steps;
      };
      const before = meanOver(10);
      nodino.update({ addNodes: { far: {} } });
      assert.equal(nodino.getStats().state, 'running');
      frames(9);
      assert.ok(meanOver(10) > before * 0.8);
      nodino.destroy();
    });

    it('stays paused, and resumes', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      frames(10);
      nodino.pause();
      nodino.update({ addEdges: [['n1', 'n2', -0.7]] });
      assert.equal(nodino.getStats().state, 'running_paused');
      nodino.start();
      frames(5);
      assert.equal(nodino.getStats().state, 'running');
      nodino.destroy();
    });

    it('runs a settled graph again, from fresh counters, to a new convergence', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      assert.ok(untilSettled(nodino));
      nodino.update({ addNodes: { x: {} }, addEdges: [['x', 'n30', 0.6]] });
      const stats = nodino.getStats();
      assert.equal(stats.state, 'running');
      assert.equal(stats.frames, 0);
      assert.equal(stats.maxFrames, 0);
      assert.ok(untilSettled(nodino));
      nodino.destroy();
    });

    it('does not restart on a metadata-only update', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      assert.ok(untilSettled(nodino));
      const state = nodino.getStats().state;
      assert.equal(nodino.update({ addNodes: { n1: { m: { renamed: true } } } }), true);
      assert.equal(nodino.getStats().state, state);
      nodino.destroy();
    });

    it('turns a forced run into a plain one', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      assert.ok(untilSettled(nodino));
      nodino.forceContinue();
      assert.equal(nodino.getStats().state, 'forced');
      nodino.update({ addEdges: [['n3', 'n4', 0.2]] });
      assert.equal(nodino.getStats().state, 'running');
      nodino.destroy();
    });

    it('restart() and the maxEdgesPerNode rebuild use the edited graph', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      nodino.start();
      frames(5);
      nodino.update({ addNodes: { x: {} }, addEdges: [['x', 'n3', 0.6]], removeNodes: ['n20'] });
      nodino.restart();
      assert.equal(nodino.getStats().state, 'loaded');
      assert.ok('x' in nodino.getPositions() && !('n20' in nodino.getPositions()));
      nodino.updateConfig({ maxEdgesPerNode: 5 });
      assert.ok('x' in nodino.getPositions() && !('n20' in nodino.getPositions()));
      nodino.destroy();
    });

    it('ignores invalid entries with one warning each, and empty patches', () => {
      const nodino = createInstance(Nodino);
      nodino.load(testGraph());
      warnings.length = 0;
      assert.equal(nodino.update({
        addEdges: [['nope', 'n1', 0.5]],
        removeNodes: ['ghost'],
        removeEdges: [['n1', 'ghost']]
      }), false);
      assert.equal(warnings.length, 3);
      assert.equal(nodino.update({}), false);
      nodino.destroy();
    });

    it('goes empty when every node is removed; a later load() starts from the host data', () => {
      const nodino = createInstance(Nodino);
      const graph = testGraph();
      nodino.load(graph);
      nodino.start();
      frames(3);
      nodino.update({ addNodes: { x: {} } });
      nodino.update({ removeNodes: Object.keys(nodino.getPositions()) });
      assert.equal(nodino.getStats().state, 'empty');
      nodino.load(graph);
      assert.equal(nodino.getStats().nodeCount, 60);
      nodino.update({ addNodes: { y: {} } });
      assert.equal(nodino.getStats().nodeCount, 61);
      assert.ok(!('x' in nodino.getPositions()));
      nodino.destroy();
    });

    it('never writes into the object passed to load()', () => {
      const nodino = createInstance(Nodino);
      const graph = testGraph();
      const snapshot = JSON.stringify(graph);
      nodino.load(graph);
      nodino.update({ addNodes: { x: {} }, addEdges: [['x', 'n1', 0.5]], removeNodes: ['n2'] });
      assert.equal(JSON.stringify(graph), snapshot);
      nodino.destroy();
    });

    it('places new nodes on the sphere in the globe geometry', () => {
      const nodino = createInstance(Nodino, { config: { geometry: 'globe' } });
      nodino.load(testGraph());
      nodino.start();
      frames(10);
      nodino.update({ addNodes: { z: {} }, addEdges: [['z', 'n2', 0.5]] });
      frames(20);
      assert.ok(allFinite(nodino));
      const z = nodino.getGlobePositions().z;
      assert.ok(Math.abs(Math.hypot(z.x, z.y, z.z) - 1) < 1e-6);
      nodino.destroy();
    });
  });
}
