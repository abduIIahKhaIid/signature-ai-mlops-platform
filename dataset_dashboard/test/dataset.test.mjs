import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  canonicalSplit,
  describeImagePath,
  isPathInside,
  itemMatchesView,
  parseClassNames,
  parseYolo,
  serializeYolo,
} from "../lib/dataset.mjs";

test("normalizes common split aliases", () => {
  assert.equal(canonicalSplit("validation"), "valid");
  assert.equal(canonicalSplit("VAL"), "valid");
  assert.equal(canonicalSplit("training"), "train");
});

test("unlabeled view includes only images without a label file", () => {
  assert.equal(itemMatchesView({ split: "train", hasLabel: false }, "unlabeled"), true);
  assert.equal(itemMatchesView({ split: "train", hasLabel: true }, "unlabeled"), false);
  assert.equal(itemMatchesView({ split: "valid", hasLabel: false }, "train"), false);
});

test("finds labels in split-first Roboflow layouts", () => {
  const root = path.resolve("C:/dataset/deep/root");
  const result = describeImagePath(path.join(root, "train", "images", "nested", "a.jpg"), root);
  assert.equal(result.split, "train");
  assert.equal(result.relativeWithinSplit, "nested/a.jpg");
  assert.equal(result.labelPath, path.join(root, "train", "labels", "nested", "a.txt"));
});

test("finds labels in images-first layouts", () => {
  const root = path.resolve("C:/dataset");
  const result = describeImagePath(path.join(root, "images", "val", "a.jpg"), root);
  assert.equal(result.split, "valid");
  assert.equal(result.labelPath, path.join(root, "labels", "val", "a.txt"));
});

test("supports flat images and labels folders without fixed splits", () => {
  const root = path.resolve("C:/dataset");
  const result = describeImagePath(path.join(root, "images", "nested", "a.jpg"), root);
  assert.equal(result.split, "all");
  assert.equal(result.layout, "unsplit");
  assert.equal(result.labelPath, path.join(root, "labels", "nested", "a.txt"));
});

test("supports ZIPs that contain loose images without any split folders", () => {
  const root = path.resolve("C:/dataset");
  const result = describeImagePath(path.join(root, "nested", "a.jpg"), root);
  assert.equal(result.split, "all");
  assert.equal(result.layout, "loose-images");
  assert.equal(result.labelPath, path.join(root, "nested", "a.txt"));
});

test("parses and serializes canonical YOLO rows", () => {
  const parsed = parseYolo("0 0.5 0.4 0.3 0.2\n");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.boxes[0].width, 0.3);
  assert.equal(serializeYolo(parsed.boxes), "0 0.5 0.4 0.3 0.2\n");
});

test("reports malformed YOLO rows", () => {
  const parsed = parseYolo("0 2 0.5 0.3 0.2\nhello");
  assert.equal(parsed.boxes.length, 0);
  assert.equal(parsed.errors.length, 2);
});

test("derives a detection box from a normalized segmentation polygon", () => {
  const parsed = parseYolo("0 0.2 0.3 0.8 0.3 0.8 0.7 0.2 0.7\n");
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.converted, 1);
  assert.equal(parsed.boxes[0].x_center, 0.5);
  assert.ok(Math.abs(parsed.boxes[0].height - 0.4) < 1e-12);
});

test("reads list and map class names", () => {
  assert.deepEqual(parseClassNames("names:\n- signature\n- stamp\nnc: 2"), ["signature", "stamp"]);
  assert.deepEqual(parseClassNames("names:\n  0: signature\n  1: stamp\ntrain: images"), ["signature", "stamp"]);
});

test("path containment rejects traversal", () => {
  assert.equal(isPathInside("C:/root/child", "C:/root"), true);
  assert.equal(isPathInside("C:/other", "C:/root"), false);
});
