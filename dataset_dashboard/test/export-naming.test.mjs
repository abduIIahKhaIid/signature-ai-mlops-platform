import test from "node:test";
import assert from "node:assert/strict";
import { createExportNamer } from "../lib/export-naming.mjs";

test("export names never collide within a folder, case-insensitively and across extensions", () => {
  const reserve = createExportNamer();
  assert.deepEqual(reserve("train", "a.jpg"), { stem: "a", fileName: "a.jpg", renamed: false });
  assert.deepEqual(reserve("train", "A.jpg"), { stem: "A__2", fileName: "A__2.jpg", renamed: true });
  assert.deepEqual(reserve("train", "a.png"), { stem: "a__3", fileName: "a__3.png", renamed: true });
  assert.deepEqual(reserve("valid", "a.jpg"), { stem: "a", fileName: "a.jpg", renamed: false });
});
