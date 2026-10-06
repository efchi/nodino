// The debug panel's Copy Config ([D Config.9]): the live config as a patch onto
// the defaults — only what differs, a theme as one choice, `debug` left out —
// and a patch that, passed back as create()'s config, gives the same config.
// Node has no clipboard, so every copy here takes the fallback: the JSON in
// a read-only box under the button.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, findByLabel, fire } = require('./helpers/dom');

function findByText(root, text) {
  const stack = [root];
  while (stack.length) {
    const el = stack.pop();
    if (el && el.textContent === text) return el;
    if (el && el.children) for (const child of el.children) stack.push(child);
  }
  return null;
}

function copied(nodino) {
  const button = findByText(nodino.__container, 'Copy Config (JSON)');
  assert.ok(button, 'Copy Config button');
  fire(button, 'click');
  const box = findByLabel(nodino.__container, 'Config JSON');
  assert.ok(box, 'fallback JSON box');
  return JSON.parse(box.value);
}

for (const [name, Nodino] of builds) {
  describe('copy config — ' + name, () => {
    it('copies an empty patch at the defaults, debug left out', () => {
      const nodino = createInstance(Nodino, { config: { debug: true } });
      assert.deepEqual(copied(nodino), {});
      nodino.destroy();
    });

    it('copies only the fields that differ, from every kind of patch', () => {
      const nodino = createInstance(Nodino, { config: { debug: true, maxEdgesPerNode: 10 } });
      nodino.updateConfig({ physics: { repulsionSpacing: 0.3 } });
      nodino.load({ edges: [['a', 'b', 0.5]] }, { config: { style: { nodeColor: '#ff0000' } } });
      assert.deepEqual(copied(nodino), { maxEdgesPerNode: 10, physics: { repulsionSpacing: 0.3 }, style: { nodeColor: '#ff0000' } });
      nodino.destroy();
    });

    it('copies a theme as the theme, plus only colours edited away from it', () => {
      const nodino = createInstance(Nodino, { config: { debug: true, theme: 'constellation' } });
      assert.deepEqual(copied(nodino), { theme: 'constellation' });
      nodino.updateConfig({ style: { nodeColor: '#ffd27a' } });
      assert.deepEqual(copied(nodino), { theme: 'constellation', style: { nodeColor: '#ffd27a' } });
      nodino.destroy();
    });

    it('round-trips: the copied patch, passed to create(), copies the same', () => {
      const first = createInstance(Nodino, { config: { debug: true, theme: 'constellation', geometry: 'plane', physics: { repulsion: 2 } } });
      const patch = copied(first);
      first.destroy();
      const second = createInstance(Nodino, { config: Object.assign({ debug: true }, patch) });
      assert.deepEqual(copied(second), patch);
      second.destroy();
    });
  });
}
