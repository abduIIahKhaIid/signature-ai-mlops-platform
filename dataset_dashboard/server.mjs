import { createReadStream, createWriteStream, existsSync, watch } from "node:fs";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { Transform, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkRepoAccess, createRepo, listFiles, repoExists, uploadFilesWithProgress, whoAmI } from "@huggingface/hub";
import {
  IMAGE_EXTENSIONS,
  describeImagePath,
  inspectFile,
  isPathInside,
  itemMatchesView,
  loadClassNames,
  parseYolo,
  replaceClassNames,
  serializeYolo,
  stableId,
  walkFiles,
} from "./lib/dataset.mjs";
import { archiveRootCandidate, assetDirectoryParts, commonPrefix } from "./lib/archive.mjs";
import { assessSignatureDataset, describeLabelIssues, isSignatureClassName } from "./lib/signature-validation.mjs";
import { createExportNamer } from "./lib/export-naming.mjs";
import {
  analyzeHubFiles,
  describeNetworkError,
  friendlyHubError,
  hubFileUrl,
  networkErrorMessage,
  isSafeRepoPath,
  normalizeRevision,
  parseHubReference,
  selectFolderFiles,
} from "./lib/huggingface.mjs";

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(APP_ROOT, "..");
const STATE_ROOT = path.resolve(process.env.DASHBOARD_STATE_ROOT || path.join(PROJECT_ROOT, ".signature-dashboard"));
const IMPORT_ROOT = path.join(STATE_ROOT, "imports");
const EXPORT_ROOT = path.join(STATE_ROOT, "exports");
const HF_TEMP_ROOT = path.join(STATE_ROOT, "huggingface-temp");
const TRASH_ROOT = path.join(STATE_ROOT, "trash");
const TRASH_RETENTION_DAYS = Math.max(1, Number(process.env.TRASH_RETENTION_DAYS) || 30);
const DATASET_NAMES_FILE = path.join(STATE_ROOT, "dataset-names.json");
const DATASET_HISTORY_FILE = path.join(STATE_ROOT, "dataset-history.json");
const PUBLIC_ROOT = path.join(APP_ROOT, "public");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const PAGE_SIZE_MAX = 60;
const HUB_URL = (process.env.HF_ENDPOINT || "https://huggingface.co").replace(/\/+$/, "");
const HUB_LIST_LIMIT = 400_000;
const HUB_FOLDER_CONCURRENCY = 6;

const datasets = new Map();
const jobs = new Map();
const jobControllers = new Map();

await Promise.all([mkdir(IMPORT_ROOT, { recursive: true }), mkdir(EXPORT_ROOT, { recursive: true }), mkdir(HF_TEMP_ROOT, { recursive: true })]);

let datasetNames = {};
try {
  datasetNames = JSON.parse(await readFile(DATASET_NAMES_FILE, "utf8"));
} catch {
  datasetNames = {};
}

let datasetHistory = [];
try {
  const storedHistory = JSON.parse(await readFile(DATASET_HISTORY_FILE, "utf8"));
  datasetHistory = Array.isArray(storedHistory) ? storedHistory : [];
} catch {
  datasetHistory = [];
}

/** Recreates .signature-dashboard and its subfolders if they were deleted while the server runs. */
async function ensureStateFolders() {
  await Promise.all([IMPORT_ROOT, EXPORT_ROOT, HF_TEMP_ROOT, TRASH_ROOT].map((folder) => mkdir(folder, { recursive: true })));
}

/** "labeled" when the label file has at least one valid box, "empty" for an empty/invalid file, "missing" when there is no file. */
/**
 * Reads a label file once and returns its state ("labeled" when it has at least one valid box,
 * "empty" for an empty/unreadable file, "missing" when there is no file) plus per-file problems.
 */
async function readLabelState(labelPath, classNames = []) {
  const info = await inspectFile(labelPath);
  if (!info?.isFile()) return { state: "missing", issues: [] };
  if (info.size === 0) return { state: "empty", issues: [] };
  try {
    const parsed = parseYolo(await readFile(labelPath, "utf8"));
    return { state: parsed.boxes.length > 0 ? "labeled" : "empty", issues: describeLabelIssues(parsed, classNames) };
  } catch {
    return { state: "empty", issues: [{ code: "invalid-rows", count: 1 }] };
  }
}

/** Box counts per class ID over all live images, read from the label files. */
async function countBoxesByClass(dataset) {
  const counts = {};
  let checked = 0;
  for (const item of dataset.items.values()) {
    if (item.deleted || item.labelState === "missing") continue;
    try {
      for (const box of parseYolo(await readFile(item.labelPath, "utf8")).boxes) counts[box.class_id] = (counts[box.class_id] || 0) + 1;
    } catch {
      // Unreadable files are reported in the Needs fixing tab.
    }
    checked += 1;
    if (checked % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return counts;
}

/** Re-reads every label file, e.g. after the class list changed, so tabs and flags stay correct. */
async function refreshLabelInfo(dataset) {
  let checked = 0;
  for (const item of dataset.items.values()) {
    if (item.deleted) continue;
    setLabelState(item, await readLabelState(item.labelPath, dataset.classNames));
    checked += 1;
    if (checked % 500 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

function classConfigPath(dataset) {
  const yml = path.join(dataset.root, "data.yml");
  return existsSync(path.join(dataset.root, "data.yaml")) || !existsSync(yml) ? path.join(dataset.root, "data.yaml") : yml;
}

function setLabelState(item, labelInfo) {
  const info = typeof labelInfo === "string" ? { state: labelInfo, issues: item.labelIssues || [] } : labelInfo;
  item.labelState = info.state;
  item.labelIssues = info.issues;
  item.hasLabel = info.state === "labeled";
}

async function moveFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

function trashEntryPath(trashId) {
  if (!/^[\w-]{6,80}$/.test(String(trashId || ""))) throw Object.assign(new Error("Unknown trash entry."), { statusCode: 404 });
  const folder = path.join(TRASH_ROOT, trashId);
  if (!isPathInside(folder, TRASH_ROOT)) throw Object.assign(new Error("Unknown trash entry."), { statusCode: 404 });
  return folder;
}

async function readTrashEntry(trashId) {
  const folder = trashEntryPath(trashId);
  try {
    const meta = JSON.parse(await readFile(path.join(folder, "meta.json"), "utf8"));
    return { folder, meta };
  } catch {
    throw Object.assign(new Error("This deleted image is no longer in the trash."), { statusCode: 404 });
  }
}

/** Moves an image and its label into .signature-dashboard/trash so the delete can be undone. */
async function trashItem(dataset, item) {
  await ensureStateFolders();
  const trashId = `${Date.now()}-${item.id}`;
  const folder = trashEntryPath(trashId);
  await mkdir(folder, { recursive: true });
  const labelExisted = existsSync(item.labelPath);
  await moveFile(item.imagePath, path.join(folder, "image", item.name));
  if (labelExisted) await moveFile(item.labelPath, path.join(folder, "label", path.basename(item.labelPath)));
  const meta = {
    trash_id: trashId,
    deleted_at: now(),
    dataset_id: dataset.id,
    dataset_name: dataset.name,
    dataset_root: dataset.root,
    item_id: item.id,
    name: item.name,
    split: item.split,
    relative: item.relative,
    image_path: item.imagePath,
    label_path: item.labelPath,
    label_existed: labelExisted,
    label_state: item.labelState,
  };
  await writeFile(path.join(folder, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

/** Permanently removes trash entries older than TRASH_RETENTION_DAYS. Runs at startup and on every page load. */
async function purgeExpiredTrash() {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of await listTrash()) {
    const deletedAt = Date.parse(entry.deleted_at);
    if (!Number.isFinite(deletedAt) || deletedAt >= cutoff) continue;
    await rm(trashEntryPath(entry.trash_id), { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

async function listTrash(datasetId = null) {
  const entries = await readdir(TRASH_ROOT, { withFileTypes: true }).catch(() => []);
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const { meta } = await readTrashEntry(entry.name);
      if (!datasetId || meta.dataset_id === datasetId) items.push(meta);
    } catch {
      // Skip damaged entries.
    }
  }
  return items.sort((left, right) => String(right.deleted_at).localeCompare(String(left.deleted_at)));
}

async function restoreTrashEntry(trashId) {
  const { folder, meta } = await readTrashEntry(trashId);
  for (const target of [meta.image_path, meta.label_path]) {
    if (!isPathInside(target, PROJECT_ROOT)) throw Object.assign(new Error("The original location is outside this project."), { statusCode: 400 });
  }
  if (existsSync(meta.image_path)) throw Object.assign(new Error(`${meta.name} already exists in the dataset again, so it was not restored.`), { statusCode: 409 });
  await moveFile(path.join(folder, "image", path.basename(meta.name)), meta.image_path);
  if (meta.label_existed) {
    const trashedLabel = path.join(folder, "label", path.basename(meta.label_path));
    if (existsSync(meta.label_path)) await rm(trashedLabel, { force: true });
    else await moveFile(trashedLabel, meta.label_path);
  }
  await rm(folder, { recursive: true, force: true });

  const dataset = datasets.get(meta.dataset_id);
  if (dataset) {
    const item = dataset.items.get(meta.item_id);
    if (item) {
      item.deleted = false;
      dataset.pathToId.set(item.imagePath, item.id);
      setLabelState(item, await readLabelState(item.labelPath, dataset.classNames));
    } else {
      await addImage(dataset, meta.image_path);
    }
  }
  return meta;
}

async function saveDatasetNames() {
  await mkdir(STATE_ROOT, { recursive: true });
  await writeFile(DATASET_NAMES_FILE, `${JSON.stringify(datasetNames, null, 2)}\n`, "utf8");
}

async function saveDatasetHistory() {
  await mkdir(STATE_ROOT, { recursive: true });
  await writeFile(DATASET_HISTORY_FILE, `${JSON.stringify(datasetHistory, null, 2)}\n`, "utf8");
}

/** A folder that can be remembered in Recent projects: inside the project, not the state folder itself. */
function isRememberableRoot(root) {
  const resolved = path.resolve(root || "");
  if (!isPathInside(resolved, PROJECT_ROOT)) return false;
  if (resolved === path.resolve(IMPORT_ROOT) || resolved === path.resolve(STATE_ROOT)) return false;
  if (isPathInside(resolved, STATE_ROOT) && !isPathInside(resolved, IMPORT_ROOT)) return false;
  return true;
}

function isManagedImport(root) {
  const resolved = path.resolve(root || "");
  return isPathInside(resolved, IMPORT_ROOT) && resolved !== path.resolve(IMPORT_ROOT);
}

/** Checks a folder before it is opened or copied, and measures what a working copy would cost. */
async function describeFolder(root) {
  const resolved = path.resolve(String(root || "").trim());
  if (!resolved || !isPathInside(resolved, PROJECT_ROOT)) throw Object.assign(new Error("The folder must be inside this project."), { statusCode: 400 });
  if (!(await inspectFile(resolved))?.isDirectory()) throw Object.assign(new Error("That folder does not exist."), { statusCode: 404 });
  if (isPathInside(STATE_ROOT, resolved)) {
    throw Object.assign(new Error("Pick a dataset folder, not a folder that contains the dashboard's own .signature-dashboard folder."), { statusCode: 400 });
  }
  let files = 0;
  let images = 0;
  let bytes = 0;
  for await (const filePath of walkFiles(resolved)) {
    files += 1;
    if (IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) images += 1;
    bytes += (await inspectFile(filePath))?.size || 0;
    if (files % 2000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return { path: resolved, name: path.basename(resolved), files, images, bytes, managed_import: isManagedImport(resolved) };
}

/** Copies an original dataset folder into imports/ so edits never touch the source files. */
async function copyFolderIntoImports(job, sourceRoot, dataset) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  const { signal } = controller;
  try {
    updateJob(job, { status: "running", phase: "copying", message: "Counting files…" });
    dataset.status = "extracting";
    dataset.message = "Making a working copy; images appear as they are copied";
    const files = [];
    for await (const filePath of walkFiles(sourceRoot)) files.push(filePath);
    // Labels and config first, so each image is shown with its boxes as soon as it lands.
    files.sort((left, right) => Number(IMAGE_EXTENSIONS.has(path.extname(left).toLowerCase())) - Number(IMAGE_EXTENSIONS.has(path.extname(right).toLowerCase())));
    updateJob(job, { total: files.length, current: 0 });
    let copied = 0;
    for (const source of files) {
      if (signal.aborted) throw cancelledError();
      const destination = path.join(dataset.root, path.relative(sourceRoot, source));
      if (!isPathInside(destination, dataset.root)) continue;
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
      copied += 1;
      if (IMAGE_EXTENSIONS.has(path.extname(destination).toLowerCase())) await addImage(dataset, destination);
      if (copied % 50 === 0 || copied === files.length) {
        updateJob(job, { current: copied, message: `${copied.toLocaleString()} of ${files.length.toLocaleString()} files copied` });
        dataset.message = `${copied.toLocaleString()} of ${files.length.toLocaleString()} files copied, ${dataset.items.size.toLocaleString()} images ready`;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    dataset.classNames = await loadClassNames(dataset.root);
    dataset.status = "indexing";
    updateJob(job, { phase: "indexing", message: "Finalizing the image index…" });
    await indexDataset(dataset, "ready");
    dataset.message = `Working copy ready. ${dataset.items.size.toLocaleString()} images; the original folder is untouched.`;
    updateJob(job, { status: "completed", phase: "completed", current: files.length, message: `Working copy ready with ${dataset.items.size.toLocaleString()} images. The original folder was not changed.` });
  } catch (error) {
    if (signal.aborted || error.cancelled) {
      await discardImport(dataset);
      updateJob(job, { status: "cancelled", phase: "cancelled", message: "Copy cancelled. The partial working copy was removed." });
    } else {
      dataset.status = "error";
      dataset.message = error.message;
      updateJob(job, { status: "failed", phase: "failed", message: error.message });
    }
  } finally {
    jobControllers.delete(job.id);
  }
}

async function rememberDataset(dataset) {
  if (!isRememberableRoot(dataset.root)) return;
  const lastOpened = now();
  dataset.lastOpened = lastOpened;
  const entry = {
    root: dataset.root,
    name: dataset.name,
    source: dataset.source,
    kind: isManagedImport(dataset.root) ? "working-copy" : "original-folder",
    last_opened: lastOpened,
  };
  datasetHistory = [entry, ...datasetHistory.filter((candidate) => path.resolve(candidate.root || "") !== dataset.root)];
  await saveDatasetHistory();
}

function now() {
  return new Date().toISOString();
}

function publicDataset(dataset) {
  const counts = {};
  let unlabeled = 0;
  let unlabeledEmpty = 0;
  let issues = 0;
  const issueCounts = {};
  for (const item of dataset.items.values()) {
    if (!item.deleted) {
      counts[item.split] = (counts[item.split] || 0) + 1;
      if (!item.hasLabel) unlabeled += 1;
      if (!item.hasLabel && item.labelState === "empty") unlabeledEmpty += 1;
      if (item.labelIssues?.length) {
        issues += 1;
        for (const issue of item.labelIssues) issueCounts[issue.code] = (issueCounts[issue.code] || 0) + 1;
      }
    }
  }
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    id: dataset.id,
    name: dataset.name,
    root: dataset.root,
    status: dataset.status,
    message: dataset.message,
    scanned: dataset.scanned,
    counts,
    unlabeled,
    unlabeled_empty: unlabeledEmpty,
    unlabeled_missing: unlabeled - unlabeledEmpty,
    issues,
    issue_counts: issueCounts,
    total,
    class_names: dataset.classNames,
    read_only: false,
    source: dataset.source,
    last_opened: dataset.lastOpened,
    managed_import: isManagedImport(dataset.root),
    original_folder: !isManagedImport(dataset.root),
    class_warning: dataset.classNames.length > 0 && !dataset.classNames.some(isSignatureClassName),
    copied_from: dataset.copiedFrom || null,
    validation: dataset.validation,
  };
}

async function registerDataset(root, options = {}) {
  const resolved = path.resolve(root);
  if (!isPathInside(resolved, PROJECT_ROOT)) throw new Error("Dataset path must be inside this project folder.");
  const info = await inspectFile(resolved);
  if (!info?.isDirectory()) throw new Error("Dataset folder does not exist.");

  const id = stableId(resolved);
  if (datasets.has(id)) return datasets.get(id);
  const dataset = {
    id,
    name: options.name || datasetNames[resolved] || path.basename(resolved),
    root: resolved,
    source: options.source || "folder",
    status: options.status || "ready",
    message: options.message || "Ready to index",
    classNames: await loadClassNames(resolved),
    items: new Map(),
    pathToId: new Map(),
    pendingImages: new Map(),
    scanned: 0,
    indexingPromise: null,
    watcher: null,
    lastOpened: options.lastOpened || null,
    validation: options.validation || null,
  };
  datasets.set(id, dataset);
  return dataset;
}

async function addImage(dataset, imagePath) {
  if (!IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) return false;
  const description = describeImagePath(imagePath, dataset.root);
  if (!description) return false;
  const absolute = path.resolve(imagePath);
  if (dataset.pathToId.has(absolute)) {
    const existing = dataset.items.get(dataset.pathToId.get(absolute));
    if (existing) setLabelState(existing, await readLabelState(description.labelPath, dataset.classNames));
    return false;
  }
  const labelKey = path.resolve(description.labelPath).toLowerCase();
  if (["extracting", "validating"].includes(dataset.status) && !existsSync(description.labelPath)) {
    dataset.pendingImages.set(labelKey, absolute);
    return false;
  }
  const info = await inspectFile(absolute);
  if (!info?.isFile()) return false;
  const id = stableId(absolute, 20);
  const item = {
    id,
    imagePath: absolute,
    labelPath: description.labelPath,
    split: description.split,
    layout: description.layout,
    relative: description.relative.replaceAll("\\", "/"),
    relativeWithinSplit: description.relativeWithinSplit,
    name: path.basename(absolute),
    bytes: info.size,
    modified: info.mtime.toISOString(),
    hasLabel: false,
    labelState: "missing",
    deleted: false,
  };
  setLabelState(item, await readLabelState(description.labelPath, dataset.classNames));
  dataset.items.set(id, item);
  dataset.pathToId.set(absolute, id);
  dataset.pendingImages.delete(labelKey);
  return true;
}

async function indexDataset(dataset, statusAfter = "ready") {
  if (dataset.indexingPromise) return dataset.indexingPromise;
  dataset.status = dataset.status === "extracting" ? "extracting" : "indexing";
  dataset.message = "Finding images without loading them into memory…";
  dataset.indexingPromise = (async () => {
    let visited = 0;
    for await (const filePath of walkFiles(dataset.root)) {
      visited += 1;
      await addImage(dataset, filePath);
      if (visited % 1000 === 0) {
        dataset.scanned = visited;
        dataset.message = `${visited.toLocaleString()} files scanned`;
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    dataset.scanned = visited;
    dataset.status = statusAfter;
    dataset.message = `${dataset.items.size.toLocaleString()} images indexed`;
    dataset.classNames = await loadClassNames(dataset.root);
  })().catch((error) => {
    dataset.status = "error";
    dataset.message = error.message;
    throw error;
  }).finally(() => {
    dataset.indexingPromise = null;
  });
  return dataset.indexingPromise;
}

/**
 * strict: class-name problems block the action (exports); otherwise they are warnings (imports).
 * singleClass: the export rewrites every box as class 0 "signature", so class names are ignored.
 * keepStatus: a failed export check must not mark the whole dataset as broken.
 */
async function validateSignatureDataset(dataset, { strict = false, singleClass = false, keepStatus = false } = {}) {
  const previous = { status: dataset.status, message: dataset.message };
  let labelFileCount = 0;
  let validLabelFileCount = 0;
  let boxCount = 0;
  let signatureBoxCount = 0;
  let checked = 0;
  const liveItems = [...dataset.items.values()].filter((item) => !item.deleted);
  const signatureClassIds = new Set(dataset.classNames
    .map((name, index) => ({ name: String(name).toLowerCase(), index }))
    .filter((entry) => entry.name.includes("signature"))
    .map((entry) => entry.index));
  dataset.status = "validating";
  dataset.message = "Validating signature images and YOLO labels…";

  for (const item of liveItems) {
    if (existsSync(item.labelPath)) {
      labelFileCount += 1;
      const parsed = parseYolo(await readFile(item.labelPath, "utf8"));
      boxCount += parsed.boxes.length;
      signatureBoxCount += parsed.boxes.filter((box) => signatureClassIds.has(box.class_id)).length;
      if (parsed.boxes.length > 0 && parsed.errors.length === 0) validLabelFileCount += 1;
    }
    checked += 1;
    if (checked % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }

  const hasExplicitClassConfig = existsSync(path.join(dataset.root, "data.yaml")) || existsSync(path.join(dataset.root, "data.yml"));
  dataset.validation = assessSignatureDataset({
    imageCount: liveItems.length,
    labelFileCount,
    validLabelFileCount,
    boxCount,
    signatureBoxCount,
    classNames: dataset.classNames,
    hasExplicitClassConfig,
    singleClass,
    strictClasses: strict,
  });
  if (!dataset.validation.valid) {
    const message = `Signature dataset check failed: ${dataset.validation.errors.join(" ")}`;
    if (keepStatus) {
      dataset.status = previous.status === "validating" ? "ready" : previous.status;
      dataset.message = previous.message;
    } else {
      dataset.status = "error";
      dataset.message = message;
    }
    throw Object.assign(new Error(message), { statusCode: 400, needsSingleClass: dataset.validation.needs_single_class });
  }
  dataset.status = "ready";
  dataset.message = `Signature check passed: ${liveItems.length.toLocaleString()} images, ${boxCount.toLocaleString()} boxes.`;
  return dataset.validation;
}

function startIncrementalWatcher(dataset) {
  try {
    dataset.watcher = watch(dataset.root, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      const fullPath = path.join(dataset.root, filename);
      if (IMAGE_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
        void addImage(dataset, fullPath);
      } else if (path.extname(fullPath).toLowerCase() === ".txt") {
        const pendingImage = dataset.pendingImages.get(path.resolve(fullPath).toLowerCase());
        if (pendingImage) void addImage(dataset, pendingImage);
      }
    });
  } catch {
    // Full indexing after extraction remains the reliable fallback.
  }
}

function makeJob(type, fields = {}) {
  const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id,
    type,
    status: "queued",
    phase: "queued",
    current: 0,
    total: null,
    message: "Queued",
    created_at: now(),
    updated_at: now(),
    ...fields,
  };
  jobs.set(id, job);
  return job;
}

function updateJob(job, changes) {
  Object.assign(job, changes, { updated_at: now() });
}

function runProcess(command, args, onLine, { signal, onErrorLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const child = spawn(command, args, { windowsHide: true, ...(signal ? { signal } : {}) });
    let stderr = "";
    let stdoutBuffer = "";
    let handlerError = null;
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      try {
        for (const line of lines) onLine?.(line);
      } catch (error) {
        handlerError = error;
        child.kill();
      }
    });
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
      if (!onErrorLine) return;
      // bsdtar (Windows' tar.exe) writes its verbose file list to stderr, not stdout.
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() || "";
      for (const line of lines) onErrorLine(line);
    });
    child.on("error", (error) => reject(signal?.aborted ? cancelledError() : error));
    child.on("close", (code) => {
      if (signal?.aborted) return reject(cancelledError());
      if (handlerError) return reject(handlerError);
      try {
        if (stdoutBuffer) onLine?.(stdoutBuffer);
      } catch (error) {
        return reject(error);
      }
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
    });
  });
}

function cancelledError() {
  return Object.assign(new Error("Import cancelled."), { cancelled: true });
}

function zipEntryIsSafe(entry) {
  const normalized = entry.trim().replaceAll("\\", "/");
  if (!normalized) return true;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}

async function importZip(job, zipPath, dataset, { signal, rethrow = false } = {}) {
  try {
    dataset.status = "validating";
    dataset.message = "Validating ZIP structure before extraction…";
    updateJob(job, { status: "running", phase: "validating", message: "Checking ZIP paths for safety…", current: 0 });
    let entries = 0;
    let rootCandidate = null;
    let commonAssetRoot = null;
    await runProcess("tar", ["-tf", zipPath], (line) => {
      if (!zipEntryIsSafe(line)) throw new Error(`Unsafe ZIP entry rejected: ${line}`);
      const candidate = archiveRootCandidate(line);
      if (candidate && (!rootCandidate || candidate.priority > rootCandidate.priority || (candidate.priority === rootCandidate.priority && candidate.depth < rootCandidate.depth))) {
        rootCandidate = candidate;
      }
      const assetRoot = assetDirectoryParts(line);
      if (assetRoot) commonAssetRoot = commonPrefix(commonAssetRoot, assetRoot);
      entries += 1;
      if (entries % 1000 === 0) {
        dataset.message = `${entries.toLocaleString()} ZIP entries validated`;
        updateJob(job, { current: entries, message: `${entries.toLocaleString()} entries checked` });
      }
    }, { signal });

    startIncrementalWatcher(dataset);
    dataset.status = "extracting";
    dataset.message = "Extracting; images appear as soon as they are available";
    const stripComponents = rootCandidate?.depth ?? commonAssetRoot?.length ?? 0;
    job.archive_root_depth = stripComponents;
    updateJob(job, { phase: "extracting", total: entries, current: 0, message: "Extracting in the background…" });
    let extracted = 0;
    const extractionArgs = ["-xvf", zipPath, ...(stripComponents > 0 ? ["--strip-components", String(stripComponents)] : []), "-C", dataset.root];
    const countExtracted = () => {
      extracted += 1;
      if (extracted % 100 === 0) {
        dataset.message = `${extracted.toLocaleString()} of ${entries.toLocaleString()} files extracted, ${dataset.items.size.toLocaleString()} images ready`;
        updateJob(job, { current: extracted, message: `${extracted.toLocaleString()} / ${entries.toLocaleString()} entries extracted` });
      }
    };
    // GNU tar lists extracted files on stdout; bsdtar (Windows) lists them as "x path" on stderr.
    await runProcess("tar", extractionArgs, countExtracted, { signal, onErrorLine: (line) => { if (/^x\s/.test(line)) countExtracted(); } });
    await rm(zipPath, { force: true });
    job.source_zip_deleted = true;
    dataset.watcher?.close();
    dataset.watcher = null;

    updateJob(job, { phase: "indexing", current: 0, total: null, message: "Finalizing the searchable image index…" });
    dataset.status = "indexing";
    await indexDataset(dataset, "validating");
    dataset.pendingImages.clear();
    updateJob(job, { phase: "signature-validation", current: 0, total: dataset.items.size, message: "Checking signature images and YOLO labels…" });
    await validateSignatureDataset(dataset);
    updateJob(job, {
      status: "completed",
      phase: "completed",
      current: dataset.items.size,
      total: dataset.items.size,
      message: `Signature check passed. ${dataset.items.size.toLocaleString()} images are ready.`,
      dataset_id: dataset.id,
    });
  } catch (error) {
    dataset.watcher?.close();
    dataset.watcher = null;
    dataset.status = "error";
    dataset.message = error.message;
    updateJob(job, { status: "failed", phase: "failed", message: error.message });
    if (rethrow) throw error;
  } finally {
    try {
      await rm(zipPath, { force: true });
      job.source_zip_deleted = true;
    } catch (error) {
      job.source_zip_deleted = false;
      job.cleanup_warning = `Temporary ZIP cleanup failed: ${error.message}`;
    }
  }
}

function safeFolderName(value) {
  const cleaned = String(value || "exported-dataset").trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\.+$/, "");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("Please enter a valid output folder name.");
  return cleaned.slice(0, 100);
}

function suggestImportFolderName(value) {
  const requested = safeFolderName(value);
  if (!existsSync(path.join(IMPORT_ROOT, requested))) return { requested, suggested: requested, available: true };
  let suffix = 2;
  let suggested;
  do {
    suggested = `${requested}-${suffix}`;
    suffix += 1;
  } while (existsSync(path.join(IMPORT_ROOT, suggested)));
  return { requested, suggested, available: false };
}

async function writeDatasetCopy(job, dataset, destination, { singleClass = false, signal = null } = {}) {
  updateJob(job, { status: "running", phase: "copying", message: "Preparing export…" });
  const items = [...dataset.items.values()].filter((item) => !item.deleted)
    .sort((left, right) => left.relative.localeCompare(right.relative, undefined, { numeric: true }));
  const reserveName = createExportNamer();
  const renamed = [];
  const labelCounts = { labeled: 0, empty: 0, missing: 0 };
  let completed = 0;
  for (const item of items) {
    if (signal?.aborted) throw cancelledError();
    const relative = item.relativeWithinSplit.split("/");
    const splitPrefix = item.split === "all" ? [] : [item.split];
    const folderParts = relative.slice(0, -1);
    const reserved = reserveName([...splitPrefix, ...folderParts].join("/"), relative.at(-1));
    if (reserved.renamed) renamed.push({ source: item.relative, exported_as: [...splitPrefix, "images", ...folderParts, reserved.fileName].join("/") });
    labelCounts[item.labelState || (item.hasLabel ? "labeled" : "missing")] += 1;
    const imageDestination = path.join(destination, ...splitPrefix, "images", ...folderParts, reserved.fileName);
    const finalLabelDestination = path.join(destination, ...splitPrefix, "labels", ...folderParts, `${reserved.stem}.txt`);
    await Promise.all([
      mkdir(path.dirname(imageDestination), { recursive: true }),
      mkdir(path.dirname(finalLabelDestination), { recursive: true }),
    ]);
    await copyFile(item.imagePath, imageDestination);
    if (!existsSync(item.labelPath)) await writeFile(finalLabelDestination, "", "utf8");
    else if (!singleClass) await copyFile(item.labelPath, finalLabelDestination);
    else {
      // Every box becomes class 0 "signature"; polygons are written as their bounding boxes.
      const { boxes } = parseYolo(await readFile(item.labelPath, "utf8"));
      await writeFile(finalLabelDestination, serializeYolo(boxes.map((box) => ({ ...box, class_id: 0 }))), "utf8");
    }
    completed += 1;
    if (completed % 25 === 0) updateJob(job, {
      current: completed,
      total: items.length,
      message: `${completed.toLocaleString()} / ${items.length.toLocaleString()} image-label pairs copied`,
    });
    if (completed % 100 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  const names = singleClass || !dataset.classNames.length ? ["signature"] : dataset.classNames;
  const availableSplits = new Set(items.map((item) => item.split));
  const splitYaml = availableSplits.has("all")
    ? ["train: images"]
    : [
        ...(availableSplits.has("train") ? ["train: train/images"] : []),
        ...(availableSplits.has("valid") ? ["val: valid/images"] : []),
        ...(availableSplits.has("test") ? ["test: test/images"] : []),
      ];
  const yaml = [
    "path: .",
    ...splitYaml,
    `nc: ${names.length}`,
    "names:",
    ...names.map((name) => `  - ${JSON.stringify(name)}`),
    "",
  ].join("\n");
  await writeFile(path.join(destination, "data.yaml"), yaml, "utf8");
  const manifest = {
    exported_at: now(),
    source: { name: dataset.name, root: dataset.root },
    images: items.length,
    labels: labelCounts,
    splits: Object.fromEntries([...availableSplits].map((split) => [split, items.filter((item) => item.split === split).length])),
    class_names: names,
    single_class: singleClass,
    original_class_names: singleClass ? dataset.classNames : undefined,
    renamed_files: renamed.length,
    renamed: renamed.slice(0, 500),
  };
  await writeFile(path.join(destination, "export-info.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  job.renamed_files = renamed.length;
  return items.length;
}

async function exportDataset(job, dataset, destination, options = {}) {
  try {
    const itemCount = await writeDatasetCopy(job, dataset, destination, options);
    updateJob(job, {
      status: "completed",
      phase: "completed",
      current: itemCount,
      total: itemCount,
      message: job.renamed_files
        ? `Export completed. ${job.renamed_files.toLocaleString()} files with duplicate names were renamed; see export-info.json.`
        : "Export completed",
      output_path: destination,
    });
  } catch (error) {
    updateJob(job, { status: "failed", phase: "failed", message: error.message });
  }
}

function normalizeHubRepoId(value) {
  return parseHubReference(value).repoId;
}

function normalizeHubToken(value, required = false) {
  const typed = String(value || "").trim();
  if (typed && !typed.startsWith("hf_")) throw Object.assign(new Error("The Hugging Face token format is invalid. Tokens start with hf_."), { statusCode: 400 });
  const token = typed || String(process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || "").trim();
  if (required && !token) throw Object.assign(new Error("A Hugging Face write token is required."), { statusCode: 400 });
  return token;
}

function hubCredentials(token) {
  return { hubUrl: HUB_URL, ...(token ? { accessToken: token } : {}) };
}

function safeHubErrorMessage(error, token) {
  const message = error instanceof Error ? error.message : String(error);
  return token ? message.replaceAll(token, "[redacted]") : message;
}

async function listHubFiles(reference, token, signal) {
  const entries = [];
  try {
    for await (const entry of listFiles({
      repo: { type: "dataset", name: reference.repoId },
      recursive: true,
      revision: reference.revision,
      ...(reference.path ? { path: reference.path } : {}),
      ...hubCredentials(token),
    })) {
      if (signal?.aborted) throw cancelledError();
      entries.push(entry);
      if (entries.length > HUB_LIST_LIMIT) throw Object.assign(new Error(`This repository has more than ${HUB_LIST_LIMIT.toLocaleString()} files. Point to a ZIP or a smaller folder.`), { statusCode: 413 });
    }
  } catch (error) {
    if (error.cancelled || error.statusCode === 413) throw error;
    const friendly = friendlyHubError(error, reference);
    friendly.message = safeHubErrorMessage(friendly, token);
    throw friendly;
  }
  return entries;
}

async function inspectHubRepository(reference, token) {
  let entries = await listHubFiles(reference, token);
  // A link to a single file (blob/resolve URL) lists nothing as a directory; fall back to its parent.
  if (!entries.length && reference.path) {
    const parent = path.posix.dirname(reference.path);
    entries = await listHubFiles({ ...reference, path: parent === "." ? "" : parent }, token);
    entries = entries.filter((entry) => entry.path === reference.path);
  }
  const analysis = analyzeHubFiles(entries);
  if (reference.path && path.posix.extname(reference.path).toLowerCase() === ".zip") {
    analysis.recommended = { mode: "zip", path: reference.path };
  }
  return {
    repo_id: reference.repoId,
    revision: reference.revision,
    path: reference.path,
    url: `${HUB_URL}/datasets/${reference.repoId}${reference.revision !== "main" || reference.path ? `/tree/${reference.revision}/${reference.path}` : ""}`,
    authenticated: Boolean(token),
    ...analysis,
  };
}

async function resolveHubZip(reference, requestedPath, token) {
  const cleanRequested = String(requestedPath || "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (cleanRequested) {
    if (!isSafeRepoPath(cleanRequested) || path.posix.extname(cleanRequested).toLowerCase() !== ".zip") {
      throw Object.assign(new Error("Hugging Face file path must point to a safe .zip file."), { statusCode: 400 });
    }
    return cleanRequested;
  }
  const { zips } = analyzeHubFiles(await listHubFiles(reference, token));
  if (zips.length === 0) throw Object.assign(new Error("This Hugging Face dataset repository does not contain a .zip file. Inspect it to import a YOLO folder instead."), { statusCode: 400 });
  if (zips.length > 1) {
    throw Object.assign(new Error(`More than one ZIP was found. Choose one: ${zips.slice(0, 8).map((zip) => zip.path).join(", ")}`), { statusCode: 400 });
  }
  return zips[0].path;
}

function createTransferMeter(job, { totalBytes: initialTotal = null, startBytes = 0, label }) {
  let totalBytes = initialTotal;
  const startedAt = Date.now();
  let samples = [{ time: startedAt, bytes: startBytes }];
  let downloaded = startBytes;
  let lastUpdate = 0;
  return {
    get bytes() { return downloaded; },
    get total() { return totalBytes; },
    setTotal(value) { if (value > 0) totalBytes = value; },
    add(count, force = false) {
      downloaded += count;
      const time = Date.now();
      if (!force && time - lastUpdate < 400) return;
      lastUpdate = time;
      samples.push({ time, bytes: downloaded });
      samples = samples.filter((sample) => time - sample.time <= 5000);
      const first = samples[0];
      const seconds = Math.max(0.001, (time - first.time) / 1000);
      const speed = Math.max(0, (downloaded - first.bytes) / seconds);
      const eta = totalBytes && speed > 0 ? Math.max(0, Math.round((totalBytes - downloaded) / speed)) : null;
      updateJob(job, {
        bytes_done: downloaded,
        bytes_total: totalBytes,
        bytes_per_second: Math.round(speed),
        eta_seconds: eta,
        message: label(downloaded, totalBytes),
      });
    },
  };
}

function formatMegabytes(bytes) {
  return `${(Number(bytes || 0) / 1024 ** 2).toFixed(1)} MB`;
}

const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(cancelledError());
  }, { once: true });
});

async function fetchHubFile({ repoId, revision, filePath, token, signal, offset = 0 }) {
  const response = await fetch(hubFileUrl(HUB_URL, repoId, revision, filePath), {
    redirect: "follow",
    signal,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      "user-agent": "signature-dataset-studio/2.0",
    },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(friendlyHubError(Object.assign(new Error(`Download failed (${response.status}) for ${filePath}.`), { statusCode: response.status }), { repoId, revision }), {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  return response;
}

/** Streams one Hub file to disk with retries; resumes from the bytes already written when the server allows it. */
async function downloadHubFileTo({ repoId, revision, filePath, token, signal, destination, onBytes, onStart, attempts = 4 }) {
  let written = 0;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetchHubFile({ repoId, revision, filePath, token, signal, offset: written });
      const resumed = written > 0 && response.status === 206;
      if (written > 0 && !resumed) {
        onBytes?.(-written);
        written = 0;
      }
      const declaredLength = Number(response.headers.get("content-length")) || 0;
      if (declaredLength) onStart?.(declaredLength + (resumed ? written : 0));
      const meter = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length;
          onBytes?.(chunk.length);
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: resumed ? "a" : "w" }), { signal });
      return { bytes: written };
    } catch (error) {
      if (signal?.aborted || error.name === "AbortError") throw cancelledError();
      const transient = error.retryable || /fetch failed|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket/i.test(`${error.message} ${error.cause?.code || ""}`);
      if (!transient || attempt >= attempts) throw error;
      await wait(Math.min(8000, 750 * 2 ** (attempt - 1)), signal);
    }
  }
}

async function downloadHubZip(job, { repoId, revision, zipPath, token, destination, signal, expectedSize = null }) {
  updateJob(job, { status: "running", phase: "huggingface-download", current: 0, total: null, message: `Downloading ${zipPath} from Hugging Face…` });
  let total = expectedSize;
  const meter = createTransferMeter(job, {
    totalBytes: total,
    label: (bytes, size) => `${formatMegabytes(bytes)}${size ? ` of ${formatMegabytes(size)}` : ""} downloaded`,
  });
  await downloadHubFileTo({
    repoId,
    revision,
    filePath: zipPath,
    token,
    signal,
    destination,
    onStart: (size) => {
      total = total || size;
      meter.setTotal(total);
    },
    onBytes: (count) => {
      meter.add(count);
      updateJob(job, { current: meter.bytes, total });
    },
  });
  meter.add(0, true);
  total = total || meter.bytes;
  updateJob(job, { current: meter.bytes, total, message: "Hugging Face ZIP downloaded; validating archive…" });
}

async function downloadHubFolder(job, dataset, { reference, folderPath, token, signal }) {
  updateJob(job, { status: "running", phase: "huggingface-listing", message: "Listing dataset files on Hugging Face…" });
  const entries = await listHubFiles({ ...reference, path: folderPath }, token, signal);
  const files = selectFolderFiles(entries, folderPath);
  if (!files.some((file) => IMAGE_EXTENSIONS.has(path.posix.extname(file.relative).toLowerCase()))) {
    throw new Error("The selected folder does not contain YOLO images/ and labels/ files.");
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  dataset.status = "downloading";
  dataset.message = `Downloading ${files.length.toLocaleString()} files from Hugging Face…`;
  let completedFiles = 0;
  const meter = createTransferMeter(job, {
    totalBytes,
    label: (bytes, size) => `${completedFiles.toLocaleString()} of ${files.length.toLocaleString()} files, ${formatMegabytes(bytes)} of ${formatMegabytes(size)}`,
  });
  updateJob(job, { phase: "huggingface-download", current: 0, total: files.length, files_total: files.length });

  let cursor = 0;
  const worker = async () => {
    while (cursor < files.length) {
      if (signal?.aborted) throw cancelledError();
      const file = files[cursor];
      cursor += 1;
      const destination = path.join(dataset.root, ...file.relative.split("/"));
      if (!isPathInside(destination, dataset.root)) throw new Error(`Unsafe repository path rejected: ${file.path}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await downloadHubFileTo({ repoId: reference.repoId, revision: reference.revision, filePath: file.path, token, signal, destination, onBytes: (count) => meter.add(count) });
      completedFiles += 1;
      if (IMAGE_EXTENSIONS.has(path.extname(destination).toLowerCase())) await addImage(dataset, destination);
      if (completedFiles % 20 === 0 || completedFiles === files.length) {
        meter.add(0, true);
        updateJob(job, { current: completedFiles });
        dataset.message = `${completedFiles.toLocaleString()} of ${files.length.toLocaleString()} files downloaded, ${dataset.items.size.toLocaleString()} images ready`;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HUB_FOLDER_CONCURRENCY, files.length) }, worker));
  meter.add(0, true);
  updateJob(job, { current: files.length, total: files.length });
  dataset.classNames = await loadClassNames(dataset.root);
}

async function discardImport(dataset) {
  dataset.watcher?.close();
  datasets.delete(dataset.id);
  datasetHistory = datasetHistory.filter((entry) => path.resolve(entry.root || "") !== dataset.root);
  await saveDatasetHistory().catch(() => {});
  if (isPathInside(dataset.root, IMPORT_ROOT) && path.resolve(dataset.root) !== path.resolve(IMPORT_ROOT)) {
    await rm(dataset.root, { recursive: true, force: true }).catch(() => {});
  }
}

async function runZipImport(job, zipPath, dataset) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  try {
    await importZip(job, zipPath, dataset, { signal: controller.signal, rethrow: true });
  } catch (error) {
    if (controller.signal.aborted || error.cancelled) {
      await discardImport(dataset);
      updateJob(job, { status: "cancelled", phase: "cancelled", message: "Import cancelled. The partially extracted folder was removed." });
    }
  } finally {
    jobControllers.delete(job.id);
  }
}

/** Removes leftovers of imports that never finished (only a source.zip or nothing at all) and stale Hub temp files. */
async function cleanupStaleState() {
  await ensureStateFolders();
  let removed = 0;
  for (const entry of await readdir(HF_TEMP_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (entry.name === "publish-cache") continue; // ZIPs kept for an unfinished publish
    await rm(path.join(HF_TEMP_ROOT, entry.name), { recursive: true, force: true }).catch(() => {});
  }
  await purgePublishCache();
  for (const entry of await readdir(IMPORT_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(IMPORT_ROOT, entry.name);
    const contents = await readdir(folder).catch(() => null);
    if (contents && contents.every((name) => name.toLowerCase() === "source.zip")) {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      removed += 1;
    }
  }
  if (removed) console.log(`Removed ${removed} unfinished import folder(s).`);
}

async function importFromHuggingFace(job, dataset, options) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  const { signal } = controller;
  try {
    if (options.mode === "folder") {
      await downloadHubFolder(job, dataset, { reference: options.reference, folderPath: options.folderPath, token: options.token, signal });
      updateJob(job, { phase: "indexing", message: "Finalizing the searchable image index…" });
      dataset.status = "indexing";
      await indexDataset(dataset, "validating");
      updateJob(job, { phase: "signature-validation", current: 0, total: dataset.items.size, message: "Checking signature images and YOLO labels…" });
      await validateSignatureDataset(dataset);
      updateJob(job, {
        status: "completed",
        phase: "completed",
        current: dataset.items.size,
        total: dataset.items.size,
        message: `Signature check passed. ${dataset.items.size.toLocaleString()} images are ready.`,
      });
    } else {
      await downloadHubZip(job, { ...options, signal });
      await importZip(job, options.destination, dataset, { signal, rethrow: true });
    }
    if (job.status === "completed") {
      job.huggingface_repo = options.repoId;
      job.huggingface_file = options.mode === "folder" ? options.folderPath || "/" : options.zipPath;
    }
  } catch (error) {
    if (signal.aborted || error.cancelled) {
      await rm(options.destination, { force: true }).catch(() => {});
      await discardImport(dataset);
      updateJob(job, { status: "cancelled", phase: "cancelled", message: "Import cancelled. Partially downloaded files were removed." });
      return;
    }
    const message = safeHubErrorMessage(error, options.token);
    dataset.status = "error";
    dataset.message = message;
    updateJob(job, { status: "failed", phase: "failed", message });
    await rm(options.destination, { force: true }).catch(() => {});
  } finally {
    jobControllers.delete(job.id);
  }
}

const PUBLISH_CACHE_ROOT = path.join(HF_TEMP_ROOT, "publish-cache");
const PUBLISH_CACHE_DAYS = 7;

const PUBLISH_STAGES = [
  ["check", "Check token and repository"],
  ["copy", "Copy images and labels"],
  ["zip", "Build the ZIP file"],
  ["hash", "Prepare the upload (SHA-256 of the ZIP)"],
  ["upload", "Upload to Hugging Face"],
  ["commit", "Create the commit"],
  ["cleanup", "Delete the local ZIP"],
];

function setStage(job, id, changes) {
  const stages = job.stages.map((stage) => (stage.id === id ? { ...stage, ...changes, updated_at: now() } : stage));
  updateJob(job, { stages, active_stage: changes.status === "running" ? id : job.active_stage });
}

function hubNetworkAware(error, token, context = {}) {
  const friendly = friendlyHubError(error, context);
  const message = safeHubErrorMessage(friendly, token);
  return Object.assign(new Error(message), { statusCode: friendly.statusCode || 400, network: friendly.network || null });
}

/**
 * Verifies the token and the destination repository before anything is copied or zipped,
 * so a wrong token or repository name is reported immediately.
 */
async function hubPublishPreflight({ repoId, token, createIfMissing, privateRepo }) {
  let me;
  try {
    me = await whoAmI({ accessToken: token, hubUrl: HUB_URL });
  } catch (error) {
    if ([401, 403].includes(Number(error?.statusCode))) {
      throw Object.assign(new Error("This Hugging Face token is not valid or has expired. Create a new token with write access and paste it again."), { statusCode: 401 });
    }
    throw hubNetworkAware(error, token);
  }
  const role = me?.auth?.accessToken?.role || null;
  if (role === "read") {
    throw Object.assign(new Error(`The token "${me.auth.accessToken.displayName}" can only read. Publishing needs a token with write access.`), { statusCode: 403 });
  }
  const [owner] = repoId.split("/");
  const namespaces = [me.name, ...(me.orgs || []).map((org) => org.name)].filter(Boolean);
  const repo = { type: "dataset", name: repoId };
  let exists;
  try {
    exists = await repoExists({ repo, ...hubCredentials(token) });
  } catch (error) {
    throw hubNetworkAware(error, token, { repoId });
  }
  if (!exists) {
    if (!createIfMissing) {
      throw Object.assign(new Error(`The dataset repository "${repoId}" was not found. Check the name, or turn on "Create the repository if it does not exist".`), { statusCode: 404 });
    }
    if (!namespaces.some((name) => name.toLowerCase() === owner.toLowerCase())) {
      throw Object.assign(new Error(`"${repoId}" does not exist, and this token cannot create repositories under "${owner}". Use ${namespaces.map((name) => `"${name}/…"`).join(" or ")}.`), { statusCode: 403 });
    }
  } else {
    try {
      await checkRepoAccess({ repo, ...hubCredentials(token) });
    } catch (error) {
      throw Object.assign(new Error(`This token has no access to "${repoId}". Check that the repository belongs to you or to one of your organizations.`), { statusCode: 403 });
    }
  }
  return {
    user: me.name,
    role: role || me?.auth?.type || "unknown",
    exists,
    detail: `Signed in as ${me.name} with a ${role || "fine-grained"} token. ${exists ? `Repository ${repoId} exists.` : `Repository ${repoId} will be created as ${privateRepo ? "private" : "public"}.`}`,
  };
}

/** Identifies exactly what would go into the ZIP, so an earlier ZIP can be reused safely. */
async function publishFingerprint(dataset, singleClass) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ root: dataset.root, singleClass, classes: dataset.classNames }));
  const items = [...dataset.items.values()].filter((item) => !item.deleted).sort((left, right) => left.relative.localeCompare(right.relative));
  let checked = 0;
  for (const item of items) {
    const [image, label] = await Promise.all([inspectFile(item.imagePath), inspectFile(item.labelPath)]);
    hash.update(`${item.relative}|${image?.size}|${image?.mtimeMs}|${label?.size ?? "-"}|${label?.mtimeMs ?? "-"}\n`);
    checked += 1;
    if (checked % 1000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  return hash.digest("hex").slice(0, 20);
}

async function purgePublishCache({ keepDatasetId = null, keepFile = null } = {}) {
  const cutoff = Date.now() - PUBLISH_CACHE_DAYS * 24 * 60 * 60 * 1000;
  for (const name of await readdir(PUBLISH_CACHE_ROOT).catch(() => [])) {
    const filePath = path.join(PUBLISH_CACHE_ROOT, name);
    const info = await inspectFile(filePath);
    const sameDataset = keepDatasetId && name.startsWith(`${keepDatasetId}-`);
    const stale = !info || info.mtimeMs < cutoff || name.endsWith(".partial");
    if (filePath === keepFile) continue;
    if (stale || sameDataset) await rm(filePath, { recursive: true, force: true }).catch(() => {});
  }
}

async function exportDatasetToHuggingFace(job, dataset, options) {
  const controller = new AbortController();
  jobControllers.set(job.id, controller);
  const { signal } = controller;
  let stagingRoot = null;
  let zipPath = null;
  let published = false;
  try {
    updateJob(job, { status: "running", phase: "copy", message: "Looking for a ZIP from an earlier attempt…" });
    await ensureStateFolders();
    await mkdir(PUBLISH_CACHE_ROOT, { recursive: true });
    const fingerprint = await publishFingerprint(dataset, options.singleClass);
    zipPath = path.join(PUBLISH_CACHE_ROOT, `${dataset.id}-${fingerprint}.zip`);
    await purgePublishCache({ keepDatasetId: dataset.id, keepFile: zipPath });
    const cached = await inspectFile(zipPath);
    let itemCount = [...dataset.items.values()].filter((item) => !item.deleted).length;

    if (cached?.isFile()) {
      const reused = `Reused the ZIP built ${new Date(cached.mtimeMs).toLocaleString()}; the dataset has not changed since.`;
      setStage(job, "copy", { status: "skipped", detail: reused });
      setStage(job, "zip", { status: "skipped", detail: `${(cached.size / 1024 ** 2).toFixed(1)} MB ZIP ready.` });
    } else {
      setStage(job, "copy", { status: "running", detail: "Starting…" });
      stagingRoot = await mkdtemp(path.join(HF_TEMP_ROOT, "export-"));
      const cleanDatasetRoot = path.join(stagingRoot, "dataset");
      await mkdir(cleanDatasetRoot, { recursive: true });
      const copyWatcher = setInterval(() => {
        if (job.total) setStage(job, "copy", { status: "running", current: job.current, total: job.total, detail: `${job.current.toLocaleString()} of ${job.total.toLocaleString()} image and label pairs copied` });
      }, 400);
      try {
        itemCount = await writeDatasetCopy(job, dataset, cleanDatasetRoot, { singleClass: options.singleClass, signal });
      } finally {
        clearInterval(copyWatcher);
      }
      setStage(job, "copy", { status: "done", current: itemCount, total: itemCount, detail: `${itemCount.toLocaleString()} image and label pairs copied.` });

      let totalEntries = 0;
      for await (const _file of walkFiles(cleanDatasetRoot)) totalEntries += 1;
      const partialPath = `${zipPath}.partial`;
      let added = 0;
      setStage(job, "zip", { status: "running", current: 0, total: totalEntries, detail: `0 of ${totalEntries.toLocaleString()} files added` });
      updateJob(job, { phase: "zip", message: "Building the ZIP file…" });
      let lastReport = 0;
      const countEntry = (line) => {
        const entry = line.trim().replace(/^a\s+/, "");
        if (!entry || entry.endsWith("/") || entry === ".") return;
        added = Math.min(totalEntries, added + 1);
        if (Date.now() - lastReport > 300 || added === totalEntries) {
          lastReport = Date.now();
          setStage(job, "zip", { status: "running", current: added, total: totalEntries, detail: `${added.toLocaleString()} of ${totalEntries.toLocaleString()} files added, ${(totalEntries - added).toLocaleString()} left` });
        }
      };
      await rm(partialPath, { force: true });
      await runProcess("tar", ["--format", "zip", "-cvf", partialPath, "-C", cleanDatasetRoot, "."], countEntry, { signal, onErrorLine: countEntry });
      await rename(partialPath, zipPath);
      const built = await inspectFile(zipPath);
      setStage(job, "zip", { status: "done", current: totalEntries, total: totalEntries, detail: `${totalEntries.toLocaleString()} files, ${(built.size / 1024 ** 2).toFixed(1)} MB. Kept until the upload succeeds.` });
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      stagingRoot = null;
    }

    const repo = { type: "dataset", name: options.repoId };
    if (!options.preflight.exists) {
      setStage(job, "check", { status: "running", detail: `Creating ${options.privateRepo ? "private" : "public"} repository ${options.repoId}…` });
      try {
        await createRepo({ repo, visibility: options.privateRepo ? "private" : "public", ...hubCredentials(options.token) });
      } catch (error) {
        if (Number(error?.statusCode) !== 409) throw error;
      }
      setStage(job, "check", { status: "done", detail: `${options.preflight.detail.replace(/will be created as/, "was created as")}` });
    }

    const zipInfo = await inspectFile(zipPath);
    const zipBytes = zipInfo?.size || 0;
    setStage(job, "hash", { status: "running", detail: `Computing the SHA-256 of ${(zipBytes / 1024 ** 2).toFixed(1)} MB. Hugging Face needs it before a large file can be uploaded.` });
    updateJob(job, { phase: "hash", message: "Preparing the upload…" });
    const iterator = uploadFilesWithProgress({
      repo,
      files: [{ path: options.zipName, content: pathToFileURL(zipPath) }],
      accessToken: options.token,
      hubUrl: HUB_URL,
      commitTitle: `Upload reviewed signature dataset ${options.zipName}`,
      maxFolderDepth: 20,
      abortSignal: signal,
    });
    let result;
    let lastUpload = 0;
    for (;;) {
      const { value, done } = await iterator.next();
      if (done) {
        result = value;
        break;
      }
      if (value.event === "phase" && value.phase === "uploadingLargeFiles") {
        setStage(job, "hash", { status: "done", detail: "SHA-256 computed." });
        setStage(job, "upload", { status: "running", current: 0, total: zipBytes, detail: `0 of ${(zipBytes / 1024 ** 2).toFixed(1)} MB uploaded` });
        updateJob(job, { phase: "upload", message: "Uploading…" });
      } else if (value.event === "phase" && value.phase === "committing") {
        if (job.stages.find((stage) => stage.id === "hash").status === "running") setStage(job, "hash", { status: "done", detail: "SHA-256 computed." });
        const uploadStage = job.stages.find((stage) => stage.id === "upload");
        setStage(job, "upload", { status: "done", current: zipBytes, total: zipBytes, detail: uploadStage.status === "running" ? `${(zipBytes / 1024 ** 2).toFixed(1)} MB uploaded.` : "Hugging Face already had this file content; nothing new had to be uploaded." });
        setStage(job, "commit", { status: "running", detail: `Adding ${options.zipName} to ${options.repoId}…` });
        updateJob(job, { phase: "commit", message: "Creating the commit…" });
      } else if (value.event === "fileProgress" && value.state === "hashing") {
        setStage(job, "hash", { status: "running", current: Math.round(value.progress * 100), total: 100, detail: `Computing the SHA-256: ${Math.round(value.progress * 100)}%` });
      } else if (value.event === "fileProgress" && value.state === "uploading" && Date.now() - lastUpload > 300) {
        lastUpload = Date.now();
        const sent = Math.round(value.progress * zipBytes);
        setStage(job, "upload", { status: "running", current: sent, total: zipBytes, detail: `${(sent / 1024 ** 2).toFixed(1)} of ${(zipBytes / 1024 ** 2).toFixed(1)} MB uploaded` });
      }
    }
    published = true;
    const hubUrl = result?.commit?.url || `https://huggingface.co/datasets/${options.repoId}`;
    setStage(job, "commit", { status: "done", detail: `Committed to ${options.repoId}.`, url: hubUrl });

    setStage(job, "cleanup", { status: "running", detail: "Deleting the local ZIP…" });
    await rm(zipPath, { force: true });
    setStage(job, "cleanup", { status: "done", detail: "The local ZIP was deleted after the upload." });
    updateJob(job, {
      status: "completed",
      phase: "completed",
      current: itemCount,
      total: itemCount,
      message: "Dataset published to Hugging Face",
      huggingface_repo: options.repoId,
      huggingface_file: options.zipName,
      hub_url: hubUrl,
    });
  } catch (error) {
    const cancelled = signal.aborted || error.cancelled || error.name === "AbortError";
    const friendly = cancelled ? null : hubNetworkAware(error, options.token, { repoId: options.repoId });
    const message = cancelled ? "Publishing cancelled." : friendly.message;
    const running = job.stages.find((stage) => stage.status === "running");
    if (running) setStage(job, running.id, { status: cancelled ? "cancelled" : "failed", detail: message });
    const zipKept = !published && zipPath && existsSync(zipPath);
    updateJob(job, {
      status: cancelled ? "cancelled" : "failed",
      phase: cancelled ? "cancelled" : "failed",
      message: zipKept ? `${message} The ZIP is kept and will be reused when you publish again.` : message,
      zip_kept: zipKept,
    });
  } finally {
    jobControllers.delete(job.id);
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function readJson(request, maxBytes = 2_000_000) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendError(response, statusCode, error) {
  sendJson(response, statusCode, { error: error instanceof Error ? error.message : String(error) });
}

function streamFile(response, filePath, contentType, cache = false) {
  const stream = createReadStream(filePath);
  stream.on("error", (error) => {
    if (!response.headersSent) sendError(response, error.code === "ENOENT" ? 404 : 500, error);
    else response.destroy(error);
  });
  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": cache ? "private, max-age=60" : "no-store",
  });
  stream.pipe(response);
}

function imageMimeType(filePath) {
  return {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  }[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function datasetOrThrow(id) {
  const dataset = datasets.get(id);
  if (!dataset) throw Object.assign(new Error("Dataset not found."), { statusCode: 404 });
  return dataset;
}

function itemOrThrow(dataset, id) {
  const item = dataset.items.get(id);
  if (!item || item.deleted) throw Object.assign(new Error("Image not found."), { statusCode: 404 });
  return item;
}

async function handleApi(request, response, url) {
  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, imports_root: IMPORT_ROOT, project_root: PROJECT_ROOT });
  }

  if (request.method === "GET" && url.pathname === "/api/datasets") {
    await forgetMissingDatasets();
    const history = [...datasets.values()]
      .sort((left, right) => String(right.lastOpened || "").localeCompare(String(left.lastOpened || "")))
      .map(publicDataset);
    return sendJson(response, 200, { datasets: history });
  }

  if (request.method === "POST" && url.pathname === "/api/folders/inspect") {
    const body = await readJson(request);
    return sendJson(response, 200, { folder: await describeFolder(body.path) });
  }

  if (request.method === "POST" && url.pathname === "/api/datasets/open") {
    const body = await readJson(request);
    if (body.copy) {
      const source = await describeFolder(body.path);
      if (source.managed_import) throw Object.assign(new Error("This folder is already a working copy. Open it directly instead."), { statusCode: 400 });
      const displayName = String(body.name || `${source.name} (copy)`).trim().replace(/\s+/g, " ").slice(0, 80);
      await ensureStateFolders();
      const folderResolution = suggestImportFolderName(body.folder_name || source.name);
      const importDirectory = path.join(IMPORT_ROOT, folderResolution.suggested);
      await mkdir(importDirectory, { recursive: true });
      const dataset = await registerDataset(importDirectory, { name: displayName, source: "copy", status: "queued", message: "Preparing the working copy…" });
      dataset.copiedFrom = source.path;
      await rememberDataset(dataset);
      const job = makeJob("copy", { dataset_id: dataset.id, source_path: source.path, cancellable: true });
      void copyFolderIntoImports(job, source.path, dataset);
      return sendJson(response, 202, { job, dataset: publicDataset(dataset), import_folder_name: folderResolution.suggested, folder_name_adjusted: !folderResolution.available });
    }
    const dataset = await registerDataset(body.path, { name: body.name });
    await rememberDataset(dataset);
    void indexDataset(dataset);
    return sendJson(response, 201, { dataset: publicDataset(dataset) });
  }

  if (request.method === "POST" && url.pathname === "/api/import/suggest-folder") {
    const body = await readJson(request);
    return sendJson(response, 200, suggestImportFolderName(body.folder_name));
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    const originalName = decodeURIComponent(request.headers["x-file-name"] || "dataset.zip");
    if (path.extname(originalName).toLowerCase() !== ".zip") throw Object.assign(new Error("Only .zip uploads are accepted."), { statusCode: 400 });
    const displayName = decodeURIComponent(request.headers["x-dataset-name"] || path.parse(originalName).name).trim().replace(/\s+/g, " ");
    if (!displayName || displayName.length > 80) throw Object.assign(new Error("Dataset display name must contain 1 to 80 characters."), { statusCode: 400 });
    const requestedFolder = decodeURIComponent(request.headers["x-import-folder"] || path.parse(originalName).name);
    const folderResolution = suggestImportFolderName(requestedFolder);
    const importFolder = folderResolution.suggested;
    const importDirectory = path.join(IMPORT_ROOT, importFolder);
    const extractDirectory = importDirectory;
    const zipPath = path.join(importDirectory, "source.zip");
    await ensureStateFolders();
    await mkdir(extractDirectory, { recursive: true });

    try {
      // pipeline() rejects when the browser aborts or loses the connection mid-upload,
      // so a cancelled upload never leaves a half-written import folder behind.
      await pipeline(request, createWriteStream(zipPath, { flags: "wx" }));
    } catch (error) {
      await rm(importDirectory, { recursive: true, force: true }).catch(() => {});
      if (request.aborted || request.destroyed) return response.destroy();
      throw error;
    }
    const dataset = await registerDataset(extractDirectory, {
      name: displayName,
      source: "zip",
      status: "queued",
      message: "ZIP uploaded; preparing background extraction",
    });
    await rememberDataset(dataset);
    const job = makeJob("import", { dataset_id: dataset.id, original_name: originalName, cancellable: true });
    void runZipImport(job, zipPath, dataset);
    return sendJson(response, 202, {
      job,
      dataset: publicDataset(dataset),
      import_folder: importDirectory,
      import_folder_name: importFolder,
      folder_name_adjusted: !folderResolution.available,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/huggingface/status") {
    const started = Date.now();
    const base = { hub_url: HUB_URL, node_version: process.version, proxy_configured: Boolean(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy), use_env_proxy: process.env.NODE_USE_ENV_PROXY === "1" };
    try {
      const probe = await fetch(`${HUB_URL}/api/datasets?limit=1`, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "signature-dataset-studio/2.0" } });
      await probe.body?.cancel().catch(() => {});
      return sendJson(response, 200, { ...base, reachable: true, hub_ok: probe.status < 500, status: probe.status, ms: Date.now() - started });
    } catch (error) {
      const details = describeNetworkError(error) || { code: error.name === "TimeoutError" ? "TIMEOUT" : "UNKNOWN", reason: error.name === "TimeoutError" ? "no answer within 10 seconds" : error.message, hint: "Check your internet connection, proxy or firewall." };
      return sendJson(response, 200, { ...base, reachable: false, ms: Date.now() - started, error: { ...details, message: networkErrorMessage(details) } });
    }
  }

  if (request.method === "POST" && url.pathname === "/api/huggingface/inspect") {
    const body = await readJson(request);
    const reference = parseHubReference(body.repo_id, body.revision || "main");
    const token = normalizeHubToken(body.token, false);
    return sendJson(response, 200, { repository: await inspectHubRepository(reference, token) });
  }

  if (request.method === "POST" && url.pathname === "/api/huggingface/import") {
    const body = await readJson(request);
    const parsed = parseHubReference(body.repo_id, body.revision || "main");
    const revision = normalizeRevision(body.revision || parsed.revision);
    const reference = { ...parsed, revision, path: "" };
    const repoId = reference.repoId;
    const token = normalizeHubToken(body.token, false);
    const mode = body.mode === "folder" ? "folder" : "zip";
    const linkedPath = parsed.path;
    let zipFile = null;
    let folderPath = null;
    if (mode === "folder") {
      folderPath = String(body.folder_path ?? (path.posix.extname(linkedPath) ? "" : linkedPath)).trim().replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      if (!isSafeRepoPath(folderPath)) throw Object.assign(new Error("The repository folder path is not safe."), { statusCode: 400 });
    } else {
      const requestedZip = body.zip_path || (path.posix.extname(linkedPath).toLowerCase() === ".zip" ? linkedPath : "");
      zipFile = await resolveHubZip({ ...reference, path: requestedZip ? "" : linkedPath }, requestedZip, token);
    }
    const sourceLabel = mode === "folder" ? (folderPath ? path.posix.basename(folderPath) : repoId.split("/").at(-1)) : path.posix.parse(zipFile).name;
    const defaultName = sourceLabel || repoId.split("/").at(-1);
    const displayName = String(body.dataset_name || defaultName).trim().replace(/\s+/g, " ");
    if (!displayName || displayName.length > 80) throw Object.assign(new Error("Dataset display name must contain 1 to 80 characters."), { statusCode: 400 });
    const folderResolution = suggestImportFolderName(body.folder_name || defaultName);
    const importDirectory = path.join(IMPORT_ROOT, folderResolution.suggested);
    const zipPath = path.join(importDirectory, "source.zip");
    await ensureStateFolders();
    await mkdir(importDirectory, { recursive: true });
    const dataset = await registerDataset(importDirectory, {
      name: displayName,
      source: "huggingface",
      status: "queued",
      message: "Connecting to Hugging Face…",
    });
    await rememberDataset(dataset);
    const job = makeJob("huggingface-import", {
      dataset_id: dataset.id,
      huggingface_repo: repoId,
      huggingface_file: mode === "folder" ? folderPath || "/" : zipFile,
      import_mode: mode,
      cancellable: true,
    });
    void importFromHuggingFace(job, dataset, {
      mode,
      reference,
      repoId,
      revision,
      zipPath: zipFile,
      folderPath,
      token,
      destination: zipPath,
      expectedSize: Number(body.expected_size) > 0 ? Number(body.expected_size) : null,
    });
    return sendJson(response, 202, {
      job,
      dataset: publicDataset(dataset),
      import_folder: importDirectory,
      import_folder_name: folderResolution.suggested,
      folder_name_adjusted: !folderResolution.available,
    });
  }

  if (segments[1] === "trash") {
    if (segments.length === 2 && request.method === "GET") {
      const entries = await listTrash(url.searchParams.get("dataset_id"));
      return sendJson(response, 200, { entries: entries.slice(0, 200), total: entries.length, retention_days: TRASH_RETENTION_DAYS });
    }
    if (segments.length === 3 && segments[2] === "purge-expired" && request.method === "POST") {
      const removed = await purgeExpiredTrash();
      return sendJson(response, 200, { removed, retention_days: TRASH_RETENTION_DAYS });
    }
    if (segments.length === 2 && request.method === "DELETE") {
      const entries = await listTrash(url.searchParams.get("dataset_id"));
      for (const entry of entries) await rm(trashEntryPath(entry.trash_id), { recursive: true, force: true });
      return sendJson(response, 200, { emptied: entries.length });
    }
    if (segments.length === 4 && segments[3] === "image" && request.method === "GET") {
      const { folder, meta } = await readTrashEntry(segments[2]);
      return streamFile(response, path.join(folder, "image", path.basename(meta.name)), imageMimeType(meta.name), true);
    }
    if (segments.length === 3 && segments[2] === "restore" && request.method === "POST") {
      const body = await readJson(request);
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 50_000) : [];
      let restored = 0;
      const failed = [];
      for (const trashId of ids) {
        try {
          await restoreTrashEntry(trashId);
          restored += 1;
        } catch (error) {
          failed.push({ trash_id: trashId, error: error.message });
        }
        if (restored % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      return sendJson(response, 200, { restored, failed });
    }
    if (segments.length === 4 && segments[3] === "restore" && request.method === "POST") {
      const meta = await restoreTrashEntry(segments[2]);
      const dataset = datasets.get(meta.dataset_id);
      return sendJson(response, 200, { restored: true, item_id: meta.item_id, dataset_id: meta.dataset_id, name: meta.name, dataset: dataset ? publicDataset(dataset) : null });
    }
  }

  if (segments[1] === "jobs" && segments.length === 4 && segments[3] === "cancel" && request.method === "POST") {
    const job = jobs.get(segments[2]);
    if (!job) throw Object.assign(new Error("Job not found."), { statusCode: 404 });
    const controller = jobControllers.get(job.id);
    if (!controller) throw Object.assign(new Error("This job can no longer be cancelled."), { statusCode: 409 });
    controller.abort();
    updateJob(job, { message: "Cancelling…" });
    return sendJson(response, 202, { job });
  }

  if (segments[1] === "jobs" && segments.length === 3 && request.method === "GET") {
    const job = jobs.get(segments[2]);
    if (!job) throw Object.assign(new Error("Job not found."), { statusCode: 404 });
    return sendJson(response, 200, { job });
  }

  if (segments[1] === "datasets" && segments.length >= 3) {
    const dataset = datasetOrThrow(segments[2]);

    if (segments.length === 4 && segments[3] === "activate" && request.method === "POST") {
      if (!BUSY_DATASET_STATUSES.has(dataset.status) && !(await inspectFile(dataset.root))?.isDirectory()) {
        await forgetMissingDatasets();
        throw Object.assign(new Error(`The folder for “${dataset.name}” no longer exists, so it was removed from Recent projects.`), { statusCode: 404 });
      }
      await rememberDataset(dataset);
      return sendJson(response, 200, { dataset: publicDataset(dataset) });
    }

    if (segments.length === 3 && request.method === "PATCH") {
      const body = await readJson(request);
      const name = String(body.name || "").trim().replace(/\s+/g, " ");
      if (!name) throw Object.assign(new Error("Dataset name cannot be empty."), { statusCode: 400 });
      if (name.length > 80) throw Object.assign(new Error("Dataset name must be 80 characters or fewer."), { statusCode: 400 });
      dataset.name = name;
      datasetNames[dataset.root] = name;
      await Promise.all([saveDatasetNames(), rememberDataset(dataset)]);
      return sendJson(response, 200, {
        dataset: publicDataset(dataset),
        message: `Dataset renamed to “${name}”.`,
      });
    }

    if (segments.length === 5 && segments[3] === "unlabeled" && segments[4] === "delete" && request.method === "POST") {
      if (BUSY_DATASET_STATUSES.has(dataset.status)) throw Object.assign(new Error("Wait until the dataset has finished loading."), { statusCode: 409 });
      const targets = [...dataset.items.values()].filter((item) => !item.deleted && !item.hasLabel);
      const trashIds = [];
      const failed = [];
      for (const item of targets) {
        try {
          const trashed = await trashItem(dataset, item);
          item.deleted = true;
          dataset.pathToId.delete(item.imagePath);
          trashIds.push(trashed.trash_id);
        } catch (error) {
          failed.push({ name: item.name, error: error.message });
        }
        if (trashIds.length % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
      }
      return sendJson(response, 200, { deleted: trashIds.length, trash_ids: trashIds, failed, dataset: publicDataset(dataset) });
    }

    if (segments.length === 4 && segments[3] === "classes" && request.method === "GET") {
      const configPath = classConfigPath(dataset);
      return sendJson(response, 200, {
        names: dataset.classNames,
        counts: await countBoxesByClass(dataset),
        config_exists: existsSync(configPath),
        config_path: configPath,
        original_folder: !isManagedImport(dataset.root),
      });
    }

    if (segments.length === 4 && segments[3] === "classes" && request.method === "PUT") {
      if (BUSY_DATASET_STATUSES.has(dataset.status)) throw Object.assign(new Error("Wait until the dataset has finished loading."), { statusCode: 409 });
      const body = await readJson(request);
      if (!Array.isArray(body.names) || body.names.length === 0) throw Object.assign(new Error("Keep at least one class."), { statusCode: 400 });
      const names = body.names.map((name) => String(name ?? "").trim().replace(/\s+/g, " "));
      if (names.some((name) => !name)) throw Object.assign(new Error("Class names cannot be empty."), { statusCode: 400 });
      if (names.some((name) => name.length > 100)) throw Object.assign(new Error("Class names must be 100 characters or fewer."), { statusCode: 400 });
      if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw Object.assign(new Error("Each class needs a different name."), { statusCode: 400 });
      const counts = await countBoxesByClass(dataset);
      const highestUsed = Math.max(-1, ...Object.keys(counts).map(Number));
      if (names.length <= highestUsed) {
        throw Object.assign(new Error(`Boxes use class ${highestUsed}, so the list needs at least ${highestUsed + 1} classes.`), { statusCode: 400 });
      }
      const configPath = classConfigPath(dataset);
      const current = existsSync(configPath) ? await readFile(configPath, "utf8") : "";
      await writeFile(configPath, replaceClassNames(current, names), "utf8");
      dataset.classNames = await loadClassNames(dataset.root);
      await refreshLabelInfo(dataset);
      dataset.validation = null;
      return sendJson(response, 200, { dataset: publicDataset(dataset), names: dataset.classNames, config_path: configPath });
    }

    if (segments.length === 4 && segments[3] === "index" && request.method === "POST") {
      void indexDataset(dataset);
      return sendJson(response, 202, { dataset: publicDataset(dataset) });
    }

    if (segments.length === 4 && segments[3] === "items" && request.method === "GET") {
      const liveItems = [...dataset.items.values()].filter((item) => !item.deleted);
      const availableSplits = [...new Set(liveItems.map((item) => item.split))];
      const availableViews = [
        ...availableSplits,
        ...(liveItems.some((item) => !item.hasLabel) ? ["unlabeled"] : []),
        ...(liveItems.some((item) => item.labelIssues?.length) ? ["issues"] : []),
      ];
      const requestedSplit = url.searchParams.get("split");
      const split = availableViews.includes(requestedSplit) ? requestedSplit : (availableSplits[0] || requestedSplit || "all");
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(url.searchParams.get("page_size")) || 18));
      const query = (url.searchParams.get("q") || "").trim().toLowerCase();
      let matching = liveItems.filter((item) => itemMatchesView(item, split));
      if (query) matching = matching.filter((item) => item.name.toLowerCase().includes(query) || item.relative.toLowerCase().includes(query));
      matching.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
      const total = matching.length;
      const pages = Math.max(1, Math.ceil(total / pageSize));
      const safePage = Math.min(page, pages);
      const items = matching.slice((safePage - 1) * pageSize, safePage * pageSize).map((item) => ({
        id: item.id,
        name: item.name,
        relative: item.relative,
        split: item.split,
        has_label: item.hasLabel,
        label_state: item.labelState,
        label_issues: item.labelIssues || [],
        bytes: item.bytes,
        image_url: `/api/datasets/${dataset.id}/items/${item.id}/image`,
      }));
      return sendJson(response, 200, { items, split, page: safePage, page_size: pageSize, pages, total, dataset: publicDataset(dataset) });
    }

    if (segments.length === 4 && segments[3] === "export" && request.method === "POST") {
      const body = await readJson(request);
      const singleClass = body.single_class === true;
      await validateSignatureDataset(dataset, { strict: true, singleClass, keepStatus: true });
      const folderName = safeFolderName(body.folder_name);
      const destination = path.join(EXPORT_ROOT, folderName);
      if (existsSync(destination)) throw Object.assign(new Error("That export folder already exists. Choose another name."), { statusCode: 409 });
      await ensureStateFolders();
      await mkdir(destination, { recursive: false });
      const job = makeJob("export", { dataset_id: dataset.id, output_path: destination, total: dataset.items.size });
      void exportDataset(job, dataset, destination, { singleClass });
      return sendJson(response, 202, { job });
    }

    if (segments.length === 4 && segments[3] === "huggingface-export" && request.method === "POST") {
      const body = await readJson(request);
      const repoId = normalizeHubRepoId(body.repo_id);
      const token = normalizeHubToken(body.token, true);
      let zipName = safeFolderName(body.zip_name || `${dataset.name} - Updated Export.zip`);
      if (!zipName.toLowerCase().endsWith(".zip")) zipName += ".zip";
      const singleClass = body.single_class === true;
      const createIfMissing = body.create_if_missing !== false;
      const privateRepo = body.private_repo !== false;
      // Everything that can fail fast is checked before any copying or zipping starts.
      await validateSignatureDataset(dataset, { strict: true, singleClass, keepStatus: true });
      const preflight = await hubPublishPreflight({ repoId, token, createIfMissing, privateRepo });
      const stages = PUBLISH_STAGES.map(([id, label]) => ({ id, label, status: "pending", detail: "" }));
      stages[0] = { ...stages[0], status: preflight.exists ? "done" : "running", detail: preflight.detail };
      const job = makeJob("huggingface-export", { dataset_id: dataset.id, huggingface_repo: repoId, huggingface_file: zipName, stages, cancellable: true });
      void exportDatasetToHuggingFace(job, dataset, {
        preflight,
        singleClass,
        repoId,
        token,
        zipName,
        createIfMissing,
        privateRepo,
      });
      return sendJson(response, 202, { job, preflight });
    }

    if (segments.length >= 5 && segments[3] === "items") {
      const item = itemOrThrow(dataset, segments[4]);

      if (segments.length === 6 && segments[5] === "image" && request.method === "GET") {
        return streamFile(response, item.imagePath, imageMimeType(item.imagePath), true);
      }

      if (segments.length === 5 && request.method === "GET") {
        let parsed = { boxes: [], errors: [], warnings: [], converted: 0 };
        try {
          parsed = parseYolo(await readFile(item.labelPath, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        return sendJson(response, 200, {
          item: {
            id: item.id,
            name: item.name,
            relative: item.relative,
            split: item.split,
            image_url: `/api/datasets/${dataset.id}/items/${item.id}/image`,
          },
          boxes: parsed.boxes,
          label_errors: [...parsed.errors, ...parsed.warnings],
          converted_polygon_rows: parsed.converted,
          label_state: item.labelState,
          label_issues: item.labelIssues || [],
          class_names: dataset.classNames,
        });
      }

      if (segments.length === 6 && segments[5] === "labels" && request.method === "PUT") {
        const body = await readJson(request);
        if (!Array.isArray(body.boxes)) throw Object.assign(new Error("boxes must be an array."), { statusCode: 400 });
        const serialized = serializeYolo(body.boxes);
        await mkdir(path.dirname(item.labelPath), { recursive: true });
        await writeFile(item.labelPath, serialized, "utf8");
        setLabelState(item, await readLabelState(item.labelPath, dataset.classNames));
        return sendJson(response, 200, { saved: true, label_state: item.labelState, label_path: item.labelPath, boxes: parseYolo(serialized).boxes });
      }

      if (segments.length === 5 && request.method === "DELETE") {
        const trashed = await trashItem(dataset, item);
        item.deleted = true;
        dataset.pathToId.delete(item.imagePath);
        return sendJson(response, 200, { deleted: true, trash_id: trashed.trash_id, image: item.imagePath, label: item.labelPath });
      }
    }
  }

  throw Object.assign(new Error("API route not found."), { statusCode: 404 });
}

const staticTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);

    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = path.resolve(PUBLIC_ROOT, requested);
    if (!isPathInside(filePath, PUBLIC_ROOT)) return sendError(response, 403, "Forbidden.");
    const fileInfo = await stat(filePath).catch(() => null);
    if (!fileInfo?.isFile()) return streamFile(response, path.join(PUBLIC_ROOT, "index.html"), staticTypes[".html"]);
    return streamFile(response, filePath, staticTypes[path.extname(filePath)] || "application/octet-stream");
  } catch (error) {
    if (!response.headersSent) sendError(response, error.statusCode || 500, error);
    else response.destroy(error);
  }
});

const BUSY_DATASET_STATUSES = new Set(["queued", "downloading", "validating", "extracting", "indexing"]);

/**
 * Forgets datasets whose folder no longer exists (for example an import folder deleted in
 * Explorer), removing them from the open-dataset list, dataset-history.json and dataset-names.json.
 */
async function forgetMissingDatasets() {
  for (const dataset of [...datasets.values()]) {
    if (BUSY_DATASET_STATUSES.has(dataset.status)) continue;
    if ((await inspectFile(dataset.root))?.isDirectory()) continue;
    dataset.watcher?.close();
    datasets.delete(dataset.id);
  }

  const keptHistory = [];
  for (const entry of datasetHistory) {
    const root = path.resolve(entry.root || "");
    if (isRememberableRoot(root) && (await inspectFile(root))?.isDirectory()) keptHistory.push(entry);
  }
  if (keptHistory.length !== datasetHistory.length) {
    datasetHistory = keptHistory;
    await saveDatasetHistory();
  }

  let namesChanged = false;
  for (const root of Object.keys(datasetNames)) {
    if ((await inspectFile(root))?.isDirectory()) continue;
    delete datasetNames[root];
    namesChanged = true;
  }
  if (namesChanged) await saveDatasetNames();
}

async function discoverDatasetHistory() {
  const candidates = new Map();
  const addCandidate = async (root, details = {}) => {
    const resolved = path.resolve(root || "");
    if (!isPathInside(resolved, PROJECT_ROOT)) return;
    const info = await inspectFile(resolved);
    if (!info?.isDirectory()) return;
    const previous = candidates.get(resolved);
    candidates.set(resolved, {
      root: resolved,
      name: details.name || previous?.name || datasetNames[resolved] || path.basename(resolved),
      lastOpened: details.last_opened || previous?.lastOpened || info.mtime.toISOString(),
    });
  };

  for (const entry of datasetHistory) {
    const rememberedRoot = path.resolve(entry.root || "");
    if (!isRememberableRoot(rememberedRoot)) continue;
    await addCandidate(rememberedRoot, entry);
  }

  const imported = await readdir(IMPORT_ROOT, { withFileTypes: true }).catch(() => []);
  for (const entry of imported) {
    if (entry.isDirectory()) await addCandidate(path.join(IMPORT_ROOT, entry.name));
  }

  const ordered = [...candidates.values()].sort((left, right) => String(right.lastOpened).localeCompare(String(left.lastOpened)));
  for (const candidate of ordered) {
    await registerDataset(candidate.root, {
      name: candidate.name,
      source: "history",
      status: "ready",
      message: "Opened before. Open it again to refresh the index.",
      lastOpened: candidate.lastOpened,
    });
  }
}

async function bootstrap() {
  await cleanupStaleState();
  await forgetMissingDatasets();
  const expired = await purgeExpiredTrash();
  if (expired) console.log(`Removed ${expired} deleted image(s) older than ${TRASH_RETENTION_DAYS} days from the trash.`);
  await discoverDatasetHistory();
  server.listen(PORT, HOST, () => {
    console.log(`Signature Dataset Dashboard: http://${HOST}:${PORT}`);
    console.log(`Imports: ${IMPORT_ROOT}`);
    console.log(`Exports: ${EXPORT_ROOT}`);
  });
}

process.on("SIGINT", () => {
  for (const dataset of datasets.values()) dataset.watcher?.close();
  server.close(() => process.exit(0));
});

await bootstrap();
