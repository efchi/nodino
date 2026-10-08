// High-density screens ([D Render.7]): the canvas's backing store is sized in
// device pixels, the viewport everything else reasons in stays in CSS pixels.

'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, frames, testGraph } = require('./helpers/dom');

// Every stub element answers 800 for `width` until something assigns one, so
// the canvas is the element whose backing store was sized away from that.
function findCanvas(container) {
  const stack = [container];
  while (stack.length) {
    const el = stack.pop();
    if (el !== container && el.width !== 800) return el;
    if (el && el.children) for (const child of el.children) stack.push(child);
  }
  return null;
}

for (const [name, Nodino] of builds) {
  describe('pixel ratio — ' + name, () => {
    afterEach(() => { global.devicePixelRatio = 1; });

    it('sizes the backing store at devicePixelRatio times the CSS size', () => {
      global.devicePixelRatio = 3;
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(20));
      frames(1);
      const canvas = findCanvas(nodino.__container);
      assert.ok(canvas, 'canvas found');
      assert.equal(canvas.width, 2400);
      assert.equal(canvas.height, 1800);
      nodino.destroy();
    });

    it('follows a change of ratio with no change of size', () => {
      global.devicePixelRatio = 2;
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(20));
      frames(1);
      const canvas = findCanvas(nodino.__container);
      assert.equal(canvas.width, 1600);
      global.devicePixelRatio = 1.5;
      frames(1);
      assert.equal(canvas.width, 1200);
      assert.equal(canvas.height, 900);
      nodino.destroy();
    });

    it('falls back to 1 on a missing or invalid ratio', () => {
      global.devicePixelRatio = 0;
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(20));
      frames(1);
      assert.equal(findCanvas(nodino.__container), null, 'backing store left at the CSS size');
      nodino.destroy();
    });
  });
}
