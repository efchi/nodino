// The card handed to onNodeHover/onNodePin ([D API.15]): the third
// argument, reset to Nodino's own classes and no inline style before every
// call, so what a host adds lasts exactly one node.

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { builds, createInstance, testGraph } = require('./helpers/dom');

for (const [name, Nodino] of builds) {
  describe('card styling — ' + name, () => {
    it('hands the card to the handler, and resets it before the next node', () => {
      const seen = [];
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(10), {
        onNodeHover: (node, body, card) => {
          seen.push({ uid: node.uid, className: card.className, color: card.style.color });
          card.classList.add('kind-' + node.uid);
          card.style.color = 'red';
          return 'x';
        }
      });
      nodino.hover('n1');
      nodino.hover('n2');
      assert.equal(seen.length, 2);
      assert.equal(seen[0].className, 'nodino-detail-panel');
      // n1's class and inline style are gone by the time n2's card is filled.
      assert.equal(seen[1].className, 'nodino-detail-panel');
      assert.equal(seen[1].color, undefined);
      nodino.destroy();
    });

    it('the pinned card keeps its own classes', () => {
      let className = null;
      const nodino = createInstance(Nodino);
      nodino.load(testGraph(10), {
        onNodePin: (node, body, card) => { className = card.className; }
      });
      nodino.pin('n3');
      assert.equal(className, 'nodino-detail-panel nodino-pinned');
      nodino.destroy();
    });
  });
}
