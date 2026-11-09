import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const javascript = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("UI contains no duplicate element IDs", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test("direct JavaScript element references exist in the HTML", () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const bracketReferences = [...javascript.matchAll(/elements\["([^"]+)"\]/g)].map((match) => match[1]);
  const propertyReferences = [...javascript.matchAll(/elements\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]);
  const missing = [...new Set([...bracketReferences, ...propertyReferences])].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test("initial experience is upload-first and review workspace is hidden", () => {
  assert.match(html, /id="welcome-view" class="welcome-view"/);
  assert.match(html, /id="workspace" class="workspace" hidden/);
  assert.match(javascript, /await loadDatasets\(\);\s*showWelcome\(\);/);
  assert.doesNotMatch(javascript, /await selectDataset\(preferred\.id\)/);
});

test("import naming, extraction loading, undo, and orientation UX are present", () => {
  assert.match(html, /id="import-dataset-name"/);
  assert.match(html, /id="import-folder-name"/);
  assert.match(html, /id="canvas-loading"/);
  assert.match(html, /id="extraction-banner"/);
  assert.match(html, /id="undo-action"/);
  assert.match(html, /id="rotate-left"/);
  assert.match(javascript, /function undoBoxes/);
  assert.match(javascript, /setOrientation/);
});

test("export animation and active dataset state are wired", () => {
  assert.match(html, /id="export-progress-dialog"/);
  assert.match(html, /id="export-progress"/);
  assert.match(javascript, /activeDatasetId/);
  assert.match(javascript, /state\.datasets = payload\.datasets/);
});

test("unlabeled images have a dedicated dynamic tab", () => {
  assert.match(javascript, /unlabeled: \["Unlabeled", "no boxes or no label file"\]/);
  assert.match(javascript, /tabCounts\.unlabeled = dataset\.unlabeled/);
});

test("welcome screen exposes upload and reusable project history", () => {
  assert.match(html, /id="drop-zone"/);
  assert.match(html, /id="project-history-list"/);
  assert.match(html, /Recent projects/);
  assert.match(javascript, /function renderProjectHistory/);
  assert.match(javascript, /dataset\.managed_import \? "Working copy" : "Original folder"/);
  assert.match(javascript, /\/activate/);
});

test("export name is suggested from the active dataset and remains editable", () => {
  assert.match(html, /id="export-name"[^>]*placeholder="Dataset Name - Updated Export"/);
  assert.match(javascript, /function suggestedExportName/);
  assert.match(javascript, /Updated Export/);
  assert.match(javascript, /elements\["export-name"\]\.value = suggestedExportName\(dataset\)/);
});

test("Hugging Face import and export dialogs keep tokens request-scoped", () => {
  assert.match(html, /id="hf-import-dialog"/);
  assert.match(html, /id="hf-export-dialog"/);
  assert.match(html, /id="hf-import-token" type="password"/);
  assert.match(html, /id="hf-export-token" type="password"/);
  assert.match(javascript, /\/api\/huggingface\/import/);
  assert.match(javascript, /huggingface-export/);
  assert.match(javascript, /hf-import-token"\]\.value = ""/);
  assert.match(javascript, /hf-export-token"\]\.value = ""/);
  assert.doesNotMatch(javascript, /localStorage/);
});
