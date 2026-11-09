import test from "node:test";
import assert from "node:assert/strict";
import { assessSignatureDataset } from "../lib/signature-validation.mjs";

test("accepts an annotated signature detection dataset", () => {
  const result = assessSignatureDataset({ imageCount: 8, labelFileCount: 7, validLabelFileCount: 7, boxCount: 9, signatureBoxCount: 9, classNames: ["signature"], hasExplicitClassConfig: true });
  assert.equal(result.valid, true);
  assert.equal(result.signature_class, true);
  assert.match(result.warnings[0], /1 image/);
});

test("rejects boxes that never use the declared signature class", () => {
  const result = assessSignatureDataset({ imageCount: 2, labelFileCount: 2, validLabelFileCount: 2, boxCount: 2, signatureBoxCount: 0, classNames: ["signature", "stamp"], hasExplicitClassConfig: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /signature class ID/);
});

test("rejects datasets without labels or an explicit signature class", () => {
  const result = assessSignatureDataset({ imageCount: 4, labelFileCount: 0, validLabelFileCount: 0, boxCount: 0, classNames: ["invoice"], hasExplicitClassConfig: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /label files/);
  assert.match(result.errors.join(" "), /signature class/);
});

test("Roboflow-style class names fail exports unless every box is saved as one signature class", () => {
  const roboflow = { imageCount: 3, labelFileCount: 3, validLabelFileCount: 3, boxCount: 4, signatureBoxCount: 0, classNames: ["-", "sign - v2 2023-05-18 5-37pm"], hasExplicitClassConfig: true };
  const strict = assessSignatureDataset(roboflow);
  assert.equal(strict.valid, false);
  assert.equal(strict.needs_single_class, true);
  assert.match(strict.errors.join(" "), /Save every box as one signature class/);
  assert.equal(assessSignatureDataset({ ...roboflow, singleClass: true }).valid, true);
  const lenient = assessSignatureDataset({ ...roboflow, strictClasses: false });
  assert.equal(lenient.valid, true);
  assert.match(lenient.warnings.join(" "), /none is named "signature"/);
});

test("per-file label problems are detected for the Needs fixing tab", async () => {
  const { describeLabelIssues } = await import("../lib/signature-validation.mjs");
  const { parseYolo } = await import("../lib/dataset.mjs");
  const parsed = parseYolo("0 0.5 0.5 0.2 0.2\n0 1.5 0.5 0.2 0.2\n0 0.1 0.1 0.3 0.1 0.2 0.4\n3 0.5 0.5 0.1 0.1\n1 0.4 0.4 0.1 0.1\n");
  const issues = Object.fromEntries(describeLabelIssues(parsed, ["signature", "stamp"]).map((issue) => [issue.code, issue.count]));
  assert.deepEqual(issues, { "invalid-rows": 1, polygon: 1, "unknown-class": 1, "other-class": 1 });
  assert.deepEqual(describeLabelIssues(parseYolo("0 0.5 0.5 0.2 0.2\n"), ["signature"]), []);
});
