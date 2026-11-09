import test from "node:test";
import assert from "node:assert/strict";
import { createBoxSnapshot, restoreBoxSnapshot } from "../public/history.js";

test("bounding-box undo snapshots are immutable copies", () => {
  const boxes = [{ class_id: 0, x_center: .5, y_center: .5, width: .2, height: .1 }];
  const snapshot = createBoxSnapshot(boxes, 0);
  boxes[0].x_center = .9;
  const restored = restoreBoxSnapshot(snapshot);
  assert.equal(restored.boxes[0].x_center, .5);
  assert.equal(restored.selectedBox, 0);
});
