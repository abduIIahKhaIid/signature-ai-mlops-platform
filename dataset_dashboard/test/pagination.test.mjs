import test from "node:test";
import assert from "node:assert/strict";
import { itemRange, paginationTokens } from "../public/pagination.js";

test("pagination stays compact around the active page", () => {
  assert.deepEqual(paginationTokens(1, 12), [1, 2, "…", 12]);
  assert.deepEqual(paginationTokens(6, 12), [1, "…", 5, 6, 7, "…", 12]);
  assert.deepEqual(paginationTokens(12, 12), [1, "…", 11, 12]);
});

test("pagination range describes only visible records", () => {
  assert.deepEqual(itemRange(1, 18, 100), { start: 1, end: 18 });
  assert.deepEqual(itemRange(6, 18, 100), { start: 91, end: 100 });
  assert.deepEqual(itemRange(1, 18, 0), { start: 0, end: 0 });
});
