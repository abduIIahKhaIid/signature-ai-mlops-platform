import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("ZIP imports expose a user-selected working folder and validation state", () => {
  assert.match(server, /x-import-folder/);
  assert.match(server, /dataset\.status = "validating"/);
  assert.match(server, /import_folder: importDirectory/);
});

test("client never runs premature manual indexing for ZIP imports", () => {
  assert.match(client, /!\["zip", "huggingface"\]\.includes\(dataset\.source\)/);
  assert.match(client, /"validating"/);
});

test("progressive extraction publishes image-label pairs atomically", () => {
  assert.match(server, /pendingImages: new Map\(\)/);
  assert.match(server, /dataset\.pendingImages\.set\(labelKey, absolute\)/);
  assert.match(server, /dataset\.pendingImages\.get\(path\.resolve\(fullPath\)\.toLowerCase\(\)\)/);
});

test("temporary ZIP is removed and existing import folders receive suggestions", () => {
  assert.match(server, /await rm\(zipPath, \{ force: true \}\)/);
  assert.match(server, /suggestImportFolderName/);
  assert.match(server, /\/api\/import\/suggest-folder/);
});

test("imports flatten detected archive roots into the chosen folder", () => {
  assert.match(server, /const extractDirectory = importDirectory/);
  assert.match(server, /archive_root_depth/);
  assert.match(server, /--strip-components/);
});

test("unlabeled images are counted and filtered as a dedicated view", () => {
  assert.match(server, /if \(!item\.hasLabel\) unlabeled \+= 1/);
  assert.match(server, /itemMatchesView\(item, split\)/);
  assert.match(server, /setLabelState\(item, await readLabelState\(item\.labelPath, dataset\.classNames\)\)/);
  assert.match(server, /async function readLabelState/);
});

test("dataset history survives restarts and discovers previous imports", () => {
  assert.match(server, /DATASET_HISTORY_FILE/);
  assert.match(server, /async function rememberDataset/);
  assert.match(server, /async function discoverDatasetHistory/);
  assert.match(server, /readdir\(IMPORT_ROOT/);
  assert.match(server, /segments\[3\] === "activate"/);
  assert.match(server, /managed_import:/);
  assert.doesNotMatch(server, /DATASET_ROOT/);
  assert.doesNotMatch(server, /AUTO_DISCOVER_DATASETS/);
  assert.doesNotMatch(server, /Object\.entries\(datasetNames\)/);
});

test("Hugging Face transfers are token-scoped background jobs", () => {
  assert.match(server, /@huggingface\/hub/);
  assert.match(server, /\/api\/huggingface\/import/);
  assert.match(server, /huggingface-export/);
  assert.match(server, /async function downloadHubZip/);
  assert.match(server, /async function exportDatasetToHuggingFace/);
  assert.doesNotMatch(server, /token:\s*token[^,]*,[^}]*makeJob/s);
});

test("imports and exports run the signature dataset validator", () => {
  assert.match(server, /async function validateSignatureDataset/);
  assert.match(server, /assessSignatureDataset/);
  assert.match(server, /Signature dataset check failed/);
});
