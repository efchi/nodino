// The proximity radius ([D View.13]): 'auto' scales with density, 'fixed'
// keeps the absolute radii. Read through the logEvents trace, which reports
// the radius and the pair count of every proximity reading computed.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, untilSettled, testGraph } = require('./helpers/dom');

// Settles a graph of `n` nodes under `config`, then switches to the
// proximity reading and returns what the trace said about it.
function proximityOf(Nodino, n, config) {
  const lines = [];
  const log = console.log;
  console.log = (label, detail) => { if (String(label).includes('proximity computed')) lines.push(detail); };
  try {
    const nodino = createInstance(Nodino, {
      config: Object.assign({ logEvents: true, geometry: 'plane' }, config)
    });
    nodino.load(testGraph(n));
    nodino.start();
    untilSettled(nodino);
    nodino.updateConfig({ viewMode: 'relations' });
    nodino.updateConfig({ viewMode: 'proximity' });
    nodino.destroy();
  } finally {
    console.log = log;
  }
  return lines[lines.length - 1];
}

for (const [name, Nodino] of builds) {
  describe('proximity radius — ' + name, () => {
    it("'auto' gives the old 0.2 at 400 nodes", () => {
      assert.ok(Math.abs(proximityOf(Nodino, 400, {}).radius - 0.2) < 1e-12);
    });

    it("'auto' widens the radius for a small graph, so it is not left bare", () => {
      const auto = proximityOf(Nodino, 20, {});
      const fixed = proximityOf(Nodino, 20, { proximityRadius: 'fixed' });
      assert.equal(fixed.radius, 0.2);
      // k ramped by √(n/400): 16 · √(20/400) ≈ 3.58 → r = √(k/20).
      const k = 16 * Math.sqrt(20 / 400);
      assert.ok(Math.abs(auto.radius - Math.sqrt(k / 20)) < 1e-12);
      assert.ok(auto.radius > fixed.radius);
      assert.ok(auto.edges > fixed.edges * 3, auto.edges + ' vs ' + fixed.edges);
    });

    it("'auto' doubles the radius on the globe", () => {
      const plane = proximityOf(Nodino, 100, {});
      const globe = proximityOf(Nodino, 100, { geometry: 'globe' });
      assert.ok(Math.abs(globe.radius - 2 * plane.radius) < 1e-12);
    });

    it('proximityNeighbors <= 0 is an empty reading', () => {
      assert.equal(proximityOf(Nodino, 50, { proximityNeighbors: 0 }).edges, 0);
    });
  });
}
