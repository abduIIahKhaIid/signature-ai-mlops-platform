import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOrientation, orientedSize, viewToSource } from "../public/geometry.js";

test("orientation uses safe quarter turns", () => {
  assert.equal(normalizeOrientation(-90), 270);
  assert.equal(normalizeOrientation(450), 90);
  assert.deepEqual(orientedSize(1200, 800, 90), { width: 800, height: 1200 });
});

test("rotated mouse coordinates map back to original label space", () => {
  assert.deepEqual(viewToSource(100, 300, 1200, 800, 90), { x: 300, y: 700 });
  assert.deepEqual(viewToSource(100, 300, 1200, 800, 270), { x: 900, y: 100 });
});
