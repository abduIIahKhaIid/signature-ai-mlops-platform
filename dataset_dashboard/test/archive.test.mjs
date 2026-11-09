import test from "node:test";
import assert from "node:assert/strict";
import { archiveRootCandidate, assetDirectoryParts, commonPrefix } from "../lib/archive.mjs";

test("detects nested dataset roots from YAML and split layouts", () => {
  assert.deepEqual(archiveRootCandidate("seven mind/final_dataset/data.yaml"), { depth: 2, priority: 3 });
  assert.deepEqual(archiveRootCandidate("wrapper/train/images/a.jpg"), { depth: 1, priority: 2 });
  assert.deepEqual(archiveRootCandidate("wrapper/images/a.jpg"), { depth: 1, priority: 1 });
});

test("finds a common root for loose image archives", () => {
  const first = assetDirectoryParts("wrapper/photos/a.jpg");
  const second = assetDirectoryParts("wrapper/photos/nested/b.jpg");
  assert.deepEqual(commonPrefix(first, second), ["wrapper", "photos"]);
});
