import assert from 'node:assert/strict';
import test from 'node:test';
import { alignTerminalPaneRect } from './terminalPaneGeometry';

test('fractional split edges meet without gaps or cumulative width rounding', () => {
  for (const width of [981, 1401, 1379]) {
    for (const ratio of [0.5, 0.333, 0.617]) {
      const edge = width * ratio;
      const left = alignTerminalPaneRect({ x: 0, y: 0, w: edge, h: 864 });
      const right = alignTerminalPaneRect({ x: edge, y: 0, w: width - edge, h: 864 });
      assert.equal(left.x + left.w, right.x);
      assert.equal(right.x + right.w, width);
      assert.ok(Object.values(right).every(Number.isInteger));
    }
  }
});

test('nested horizontal and vertical splits share the same rounded edges', () => {
  const first = alignTerminalPaneRect({ x: 0, y: 0, w: 490.5, h: 432.5 });
  const second = alignTerminalPaneRect({ x: 490.5, y: 0, w: 490.5, h: 432.5 });
  const below = alignTerminalPaneRect({ x: 490.5, y: 432.5, w: 490.5, h: 432.5 });
  assert.equal(first.x + first.w, second.x);
  assert.equal(second.y + second.h, below.y);
  assert.equal(below.y + below.h, 865);
});
