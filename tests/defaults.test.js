// Nodino.defaults ([F API.15]): DEFAULT_CONFIG as a host reads it — the
// documented values, frozen all the way down, and a copy, so reading or
// trying to write it never changes what create() starts from.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance } = require('./helpers/dom');

for (const [name, Nodino] of builds) {
  describe('defaults — ' + name, () => {
    it('holds the documented defaults', () => {
      assert.equal(Nodino.defaults.maxEdgesPerNode, 15);
      assert.equal(Nodino.defaults.geometry, 'globe');
      assert.equal(Nodino.defaults.physics.repulsionSpacing, 1.2);
      assert.equal(Nodino.defaults.style.nodeRadiusMax, 2.5);
    });

    it('is frozen at every level', () => {
      assert.ok(Object.isFrozen(Nodino.defaults));
      assert.ok(Object.isFrozen(Nodino.defaults.physics));
      assert.ok(Object.isFrozen(Nodino.defaults.style));
      assert.throws(() => { 'use strict'; Nodino.defaults.physics.repulsionSpacing = 9; });
    });

    it('is a copy: create() and a config patch leave it untouched', () => {
      const nodino = createInstance(Nodino, { config: { physics: { repulsionSpacing: 0.2 } } });
      nodino.updateConfig({ physics: { repulsionSpacing: 0.3 } });
      assert.equal(Nodino.defaults.physics.repulsionSpacing, 1.2);
      nodino.destroy();
    });
  });
}
