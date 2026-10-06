// Themes ([D Config.8]): Nodino.themes, config.theme at create() and through
// updateConfig(), colours in the same patch winning over the theme, unknown
// names refused. The applied colours are read back through the debug panel's
// fields, which re-read the live config after every change.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, findByLabel, warnings } = require('./helpers/dom');

function field(nodino, label) {
  const input = findByLabel(nodino.__container, label);
  assert.ok(input, 'field ' + label);
  return input.value;
}

for (const [name, Nodino] of builds) {
  describe('themes — ' + name, () => {
    it('Nodino.themes lists light and constellation, frozen', () => {
      assert.deepEqual(Object.keys(Nodino.themes), ['light', 'constellation']);
      assert.equal(Nodino.themes.light.label, 'Light (Default)');
      assert.ok(Object.isFrozen(Nodino.themes) && Object.isFrozen(Nodino.themes.constellation.style));
      assert.throws(() => { 'use strict'; Nodino.themes.constellation.style.nodeColor = '#000000'; });
    });

    it('the light theme is the defaults', () => {
      const nodino = createInstance(Nodino, { config: { debug: true } });
      assert.equal(field(nodino, 'Node Color'), Nodino.themes.light.style.nodeColor);
      assert.equal(field(nodino, 'Area Background'), Nodino.themes.light.style.backgroundColor);
      nodino.destroy();
    });

    it('config.theme at create() applies the theme, and a colour in the same patch wins', () => {
      const nodino = createInstance(Nodino, {
        config: { debug: true, theme: 'constellation', style: { nodeColor: '#ff0000' } }
      });
      assert.equal(field(nodino, 'Area Background'), Nodino.themes.constellation.style.backgroundColor);
      assert.equal(field(nodino, 'Label Color'), Nodino.themes.constellation.style.labelColor);
      assert.equal(field(nodino, 'Node Color'), '#ff0000');
      assert.equal(field(nodino, 'Theme'), 'constellation');
      nodino.destroy();
    });

    it('updateConfig({ theme }) switches back and forth', () => {
      const nodino = createInstance(Nodino, { config: { debug: true } });
      nodino.updateConfig({ theme: 'constellation' });
      assert.equal(field(nodino, 'Node Color'), Nodino.themes.constellation.style.nodeColor);
      nodino.updateConfig({ theme: 'light' });
      assert.equal(field(nodino, 'Node Color'), Nodino.themes.light.style.nodeColor);
      assert.equal(field(nodino, 'Theme'), 'light');
      nodino.destroy();
    });

    it('the container carries the theme class the chrome is coloured by', () => {
      const nodino = createInstance(Nodino, { config: { theme: 'constellation' } });
      const classes = nodino.__container.classList;
      assert.ok(classes.contains('nodino-theme-constellation'));
      nodino.updateConfig({ theme: 'light' });
      assert.ok(classes.contains('nodino-theme-light') && !classes.contains('nodino-theme-constellation'));
      nodino.destroy();
      assert.ok(!classes.contains('nodino-theme-light'), 'removed on destroy');
    });

    it('an unknown theme is refused with a warning, and changes nothing', () => {
      const nodino = createInstance(Nodino, { config: { debug: true } });
      warnings.length = 0;
      nodino.updateConfig({ theme: 'neon' });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /Unknown theme "neon"/);
      assert.equal(field(nodino, 'Theme'), 'light');
      assert.equal(field(nodino, 'Node Color'), Nodino.themes.light.style.nodeColor);
      nodino.destroy();
    });
  });
}
