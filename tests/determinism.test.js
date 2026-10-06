// Determinism ([F Det.1]): the same input gives the same layout, a restart
// after edits gives what a fresh load of the edited graph gives, and the
// minified build lays out exactly like the readable one.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { builds, createInstance, frames, testGraph } = require('./helpers/dom');

// The layout of a fixed graph after a fixed number of steps, both geometries,
// hashed. A change to this value is a change to what Nodino computes: any
// edit to the physics, the initial placement, the sparsification or the edge
// order shows up here first. If the change is intended, update the constant
// in the same commit and say so in the CHANGELOG — a host that re-runs a
// graph instead of restoring a cached layout gets a different picture.
const GOLDEN = '4ff3f8b67fc91d0db258eb0c01fee5bbdbd840ad379d369743c1b42b881a1521';

function goldenHash(Nodino) {
  const nodino = createInstance(Nodino, { config: { physics: { maxConvergenceSeconds: 0, maxConvergenceFrames: 0 } } });
  nodino.load(testGraph(100));
  nodino.start();
  frames(300);
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify([nodino.getPositions(), nodino.getGlobePositions()]))
    .digest('hex');
  nodino.destroy();
  return hash;
}

function layout(Nodino, graph, steps) {
  const nodino = createInstance(Nodino);
  nodino.load(graph);
  nodino.start();
  frames(steps);
  const out = [nodino.getPositions(), nodino.getGlobePositions()];
  nodino.destroy();
  return out;
}

for (const [name, Nodino] of builds) {
  describe('determinism — ' + name, () => {
    it('the reference layout is unchanged (golden hash)', () => {
      assert.equal(goldenHash(Nodino), GOLDEN);
    });

    it('the same input gives the same layout, bit for bit', () => {
      assert.deepEqual(layout(Nodino, testGraph(), 80), layout(Nodino, testGraph(), 80));
    });

    it('restart() after edits equals a fresh load() of the edited graph', () => {
      const graph = testGraph();
      const nodino = createInstance(Nodino);
      nodino.load(graph);
      nodino.start();
      frames(40);
      nodino.update({ addNodes: { x: {} }, addEdges: [['x', 'n3', 0.7]], removeNodes: ['n9'] });
      frames(40);
      nodino.restart();
      nodino.start();
      frames(100);
      const edited = nodino.getPositions();
      nodino.destroy();

      const nodes = Object.assign({}, graph.nodes, { x: {} });
      delete nodes.n9;
      const edges = graph.edges.filter((e) => e[0] !== 'n9' && e[1] !== 'n9').concat([['x', 'n3', 0.7]]);
      const fresh = createInstance(Nodino);
      fresh.load({ nodes, edges });
      fresh.start();
      frames(100);
      assert.deepEqual(edited, fresh.getPositions());
      fresh.destroy();
    });
  });
}

if (builds.length > 1) {
  it('the minified build lays out exactly like the readable one', () => {
    const graph = testGraph(80);
    assert.deepEqual(layout(builds[1][1], graph, 150), layout(builds[0][1], graph, 150));
  });
}
