import { itemRange, paginationTokens } from "/pagination.js";
import { normalizeOrientation, orientedSize, viewToSource } from "/geometry.js";
import { createBoxSnapshot, restoreBoxSnapshot } from "/history.js";

const BUSY_STATUSES = ["queued", "downloading", "validating", "extracting", "indexing"];
const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((element) => [element.id, element]));

const state = {
  datasets: [],
  dataset: null,
  split: "train",
  page: 1,
  pageSize: 18,
  query: "",
  pages: 1,
  currentItem: null,
  boxes: [],
  selectedBox: -1,
  image: null,
  tool: "select",
  pointerAction: null,
  dirty: false,
  refreshTimer: null,
  visibleItems: [],
  totalItems: 0,
  navigationLock: false,
  imageRequestToken: 0,
  pendingUpload: null,
  editorLoading: false,
  undoStack: [],
  orientation: 0,
  activeDatasetId: null,
  exportNameDatasetId: null,
};

function showWorkspace() {
  elements["welcome-view"].hidden = true;
  elements.workspace.hidden = false;
  document.querySelector(".skip-link").href = "#workspace";
}

function showWelcome() {
  elements["welcome-view"].hidden = false;
  elements.workspace.hidden = true;
  document.querySelector(".skip-link").href = "#welcome-view";
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function formatHistoryDate(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "Previously used";
  return `Opened ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)}`;
}

function suggestedExportName(dataset) {
  const safeName = String(dataset?.name || "dataset").trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\.+$/, "") || "dataset";
  return `${safeName} - Updated Export`;
}

/**
 * Toasts and the activity card must stay visible and clickable while a modal dialog
 * (such as the full-screen reviewer) is open, so they are moved into the topmost open dialog.
 */
function raiseToTop(element) {
  const openDialogs = [...document.querySelectorAll("dialog[open]")];
  const host = openDialogs.at(-1) || document.body;
  if (element.parentElement !== host) host.append(element);
}

function toast(message, type = "info", { actionLabel = null, onAction = null, duration = null } = {}) {
  const node = document.createElement("div");
  node.className = `toast ${type === "error" ? "error" : ""}`;
  node.setAttribute("role", type === "error" ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  node.append(text);
  if (actionLabel && onAction) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = actionLabel;
    button.addEventListener("click", () => {
      node.remove();
      onAction();
    }, { once: true });
    node.append(button);
  }
  elements["toast-region"].append(node);
  raiseToTop(elements["toast-region"]);
  setTimeout(() => node.remove(), duration || (actionLabel ? 10000 : 5000));
  return node;
}

function datasetOptionLabel(dataset) {
  return `${dataset.name} (${formatCount(dataset.total)} ${dataset.total === 1 ? "image" : "images"})`;
}

function setDatasetSummary(dataset) {
  state.dataset = dataset || null;
  const option = dataset ? [...elements["dataset-select"].options].find((candidate) => candidate.value === dataset.id) : null;
  if (option) option.textContent = datasetOptionLabel(dataset);
  elements["dataset-heading"].textContent = dataset?.name || "Choose a dataset to begin";
  elements["dataset-message"].textContent = dataset?.message || "Images are indexed as file paths only and loaded on demand.";
  const statusText = String(dataset?.status || "waiting");
  elements["dataset-status"].innerHTML = `<span class="status-dot"></span>${statusText.charAt(0).toUpperCase()}${statusText.slice(1)}`;
  elements["dataset-status"].dataset.tone = !dataset ? "" : dataset.status === "error" ? "error" : BUSY_STATUSES.includes(dataset.status) ? "busy" : "ok";
  elements["dataset-validation"].dataset.tone = !dataset?.validation ? "" : dataset.validation.valid ? "ok" : "error";
  elements["dataset-validation"].title = dataset?.validation?.errors?.length ? dataset.validation.errors.join(" ") : (dataset?.validation?.warnings || []).join(" ");
  elements["dataset-total"].textContent = dataset ? formatCount(dataset.total) : "—";
  elements["dataset-classes"].textContent = dataset?.class_names?.length ? dataset.class_names.join(", ") : "—";
  elements["dataset-classes"].dataset.tone = dataset?.class_warning ? "warn" : "";
  elements["dataset-classes"].title = dataset?.class_warning ? "No class is named \"signature\". Exports can save every box as one signature class." : "";
  elements["dataset-validation"].textContent = !dataset?.validation
    ? "Not checked"
    : dataset.validation.valid
      ? `Passed, ${formatCount(dataset.validation.box_count)} boxes`
      : "Failed signature check";
  if (!dataset) {
    state.exportNameDatasetId = null;
    elements["export-name"].value = "";
  } else if (state.exportNameDatasetId !== dataset.id) {
    state.exportNameDatasetId = dataset.id;
    elements["export-name"].value = suggestedExportName(dataset);
    elements["hf-export-zip-name"].value = `${suggestedExportName(dataset)}.zip`;
    // Datasets whose data.yaml has no "signature" class (for example Roboflow's "-" placeholder) export as one class by default.
    elements["export-single-class"].checked = Boolean(dataset.class_warning);
    elements["hf-single-class"].checked = Boolean(dataset.class_warning);
  }
  renderSplitTabs(dataset);
  renderOriginalBanner(dataset);
  elements["reindex-button"].disabled = !dataset;
  elements["rename-dataset"].disabled = !dataset;
}

function renderSplitTabs(dataset) {
  const labels = {
    train: ["Train", "training images"],
    valid: ["Validation", "validation images"],
    test: ["Test", "testing images"],
    all: ["All images", "unsplit dataset"],
    unlabeled: ["Unlabeled", "no boxes or no label file"],
    issues: ["Needs fixing", "label files with problems"],
  };
  const order = ["train", "valid", "test", "all", "unlabeled", "issues"];
  const tabCounts = { ...(dataset?.counts || {}) };
  if (dataset?.unlabeled > 0) tabCounts.unlabeled = dataset.unlabeled;
  if (dataset?.issues > 0) tabCounts.issues = dataset.issues;
  const entries = Object.entries(tabCounts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => {
      const leftRank = order.includes(left) ? order.indexOf(left) : order.length;
      const rightRank = order.includes(right) ? order.indexOf(right) : order.length;
      return leftRank - rightRank;
    });
  elements["split-tabs"].hidden = entries.length === 0;
  elements["split-tabs"].replaceChildren();
  if (!entries.length) return;
  if (!entries.some(([split]) => split === state.split)) state.split = entries[0][0];
  for (const [split, count] of entries) {
    const [title, description] = labels[split] || [split, `${split} images`];
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat ${state.split === split ? "active" : ""}`;
    button.dataset.split = split;
    button.setAttribute("aria-pressed", String(state.split === split));
    const titleNode = document.createElement("span");
    titleNode.textContent = title;
    const countNode = document.createElement("strong");
    countNode.textContent = formatCount(count);
    const descriptionNode = document.createElement("small");
    descriptionNode.textContent = description;
    button.append(titleNode, countNode, descriptionNode);
    button.addEventListener("click", () => setSplit(split));
    elements["split-tabs"].append(button);
  }
}

function renderProjectHistory(datasets) {
  const history = [...(datasets || [])]
    .sort((left, right) => String(right.last_opened || "").localeCompare(String(left.last_opened || "")));
  elements["project-history-count"].textContent = formatCount(history.length);
  elements["project-history-list"].replaceChildren();
  elements["project-history-list"].hidden = history.length === 0;
  elements["project-history-empty"].hidden = history.length > 0;

  for (const dataset of history) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project-history-card";
    button.setAttribute("aria-label", `Open ${dataset.name}`);

    const icon = document.createElement("span");
    icon.className = "history-folder-icon";
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h7l2 2h9v10H3z"/><path d="M8 14h8m-4-4v8"/></svg>';

    const copy = document.createElement("span");
    copy.className = "history-card-copy";
    const name = document.createElement("strong");
    name.textContent = dataset.name;
    const kind = document.createElement("span");
    kind.className = `history-kind ${dataset.managed_import ? "history-kind-copy" : "history-kind-original"}`;
    kind.textContent = dataset.managed_import ? "Working copy" : "Original folder";
    kind.title = dataset.managed_import ? "Edits only change the copy in .signature-dashboard/imports" : "Edits change the real files in this folder";
    const pathNode = document.createElement("small");
    pathNode.textContent = dataset.root;
    pathNode.title = dataset.root;
    const meta = document.createElement("span");
    meta.className = "history-card-meta";
    const imageCount = document.createElement("span");
    imageCount.textContent = dataset.total > 0 ? `${formatCount(dataset.total)} images` : "Open to scan";
    const lastOpened = document.createElement("span");
    lastOpened.textContent = formatHistoryDate(dataset.last_opened);
    meta.append(imageCount, lastOpened);
    if (dataset.unlabeled > 0) {
      const unlabeled = document.createElement("span");
      unlabeled.className = "history-warning";
      unlabeled.textContent = `${formatCount(dataset.unlabeled)} unlabeled`;
      meta.append(unlabeled);
    }
    copy.append(name, kind, pathNode, meta);

    const arrow = document.createElement("span");
    arrow.className = "history-open-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML = '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>';
    button.append(icon, copy, arrow);
    button.addEventListener("click", () => void selectDataset(dataset.id));
    elements["project-history-list"].append(button);
  }
}

async function loadDatasets(preferredId = null) {
  const payload = await api("/api/datasets");
  if (preferredId) state.activeDatasetId = preferredId;
  state.datasets = payload.datasets;
  renderProjectHistory(state.datasets);
  const selectedId = state.activeDatasetId || state.dataset?.id || elements["dataset-select"].value;
  elements["dataset-select"].replaceChildren(new Option("Choose a dataset", ""));
  for (const dataset of state.datasets) {
    const option = new Option(datasetOptionLabel(dataset), dataset.id);
    elements["dataset-select"].append(option);
  }
  if (selectedId && state.datasets.some((dataset) => dataset.id === selectedId)) {
    elements["dataset-select"].value = selectedId;
    const selected = state.datasets.find((dataset) => dataset.id === selectedId);
    setDatasetSummary(selected);
  }
  return state.datasets;
}

async function selectDataset(id) {
  clearTimeout(state.refreshTimer);
  state.activeDatasetId = id || null;
  elements["dataset-select"].value = id || "";
  const dataset = state.datasets.find((candidate) => candidate.id === id);
  setDatasetSummary(dataset);
  state.page = 1;
  if (!dataset) {
    showWelcome();
    elements["image-grid"].replaceChildren();
    elements["empty-state"].hidden = false;
    return;
  }
  let activated;
  try {
    activated = await api(`/api/datasets/${dataset.id}/activate`, { method: "POST", body: "{}" });
  } catch (error) {
    toast(error.message, "error");
    state.activeDatasetId = null;
    setDatasetSummary(null);
    await loadDatasets().catch(() => {});
    showWelcome();
    return;
  }
  Object.assign(dataset, activated.dataset);
  renderProjectHistory(state.datasets);
  setDatasetSummary(dataset);
  showWorkspace();
  if (dataset.total === 0 && !["zip", "huggingface"].includes(dataset.source) && !BUSY_STATUSES.includes(dataset.status)) {
    await api(`/api/datasets/${dataset.id}/index`, { method: "POST", body: "{}" });
  }
  await loadItems();
  scheduleDatasetRefresh();
  void refreshTrashCount();
}

function scheduleDatasetRefresh() {
  clearTimeout(state.refreshTimer);
  if (!state.dataset || !BUSY_STATUSES.includes(state.dataset.status)) return;
  state.refreshTimer = setTimeout(async () => {
    if (!state.dataset) return;
    try {
      await loadDatasets(state.dataset.id);
      await loadItems({ quiet: true });
      scheduleDatasetRefresh();
    } catch (error) {
      if (!/Dataset not found/.test(error.message)) toast(error.message, "error");
    }
  }, 1600);
}

function renderGrid(items, { skeletons = 0 } = {}) {
  elements["image-grid"].replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = document.createElement("button");
    card.className = "image-card";
    card.type = "button";
    card.dataset.itemId = item.id;
    card.setAttribute("aria-label", `Edit ${item.name}`);

    const thumb = document.createElement("span");
    thumb.className = "thumb loading";
    const image = document.createElement("img");
    image.src = item.image_url;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    image.addEventListener("load", () => thumb.classList.remove("loading"), { once: true });
    image.addEventListener("error", () => {
      thumb.classList.remove("loading");
      thumb.classList.add("image-error");
      image.remove();
    }, { once: true });
    thumb.append(image);

    const copy = document.createElement("span");
    copy.className = "card-copy";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const detail = document.createElement("small");
    const splitName = document.createElement("span");
    splitName.className = "card-split";
    splitName.textContent = { train: "Train", valid: "Valid", test: "Test", all: "Unsplit" }[item.split] || item.split;
    const size = document.createElement("span");
    size.textContent = formatBytes(item.bytes);
    detail.append(splitName, size);
    copy.append(name, detail);
    card.append(thumb, copy);
    if (item.label_issues?.length) {
      const flag = document.createElement("span");
      flag.className = "card-flag flag-issue";
      flag.textContent = ISSUE_TEXT[item.label_issues[0].code] || "Label problem";
      flag.title = item.label_issues.map((issue) => `${ISSUE_TEXT[issue.code] || issue.code}: ${issue.count}`).join(", ");
      card.append(flag);
    } else if (item.has_label === false) {
      const flag = document.createElement("span");
      flag.className = `card-flag ${item.label_state === "empty" ? "flag-empty" : ""}`;
      flag.textContent = item.label_state === "empty" ? "Empty label" : "No label file";
      card.append(flag);
    }
    card.addEventListener("click", () => openEditor(item.id));
    fragment.append(card);
  }
  for (let index = 0; index < skeletons; index += 1) {
    const card = document.createElement("div");
    card.className = "image-card skeleton-card";
    const thumb = document.createElement("span");
    thumb.className = "thumb loading";
    const copy = document.createElement("span");
    copy.className = "card-copy";
    const firstLine = document.createElement("span");
    firstLine.className = "skeleton-line";
    const secondLine = document.createElement("span");
    secondLine.className = "skeleton-line short";
    copy.append(firstLine, secondLine);
    card.append(thumb, copy);
    fragment.append(card);
  }
  elements["image-grid"].append(fragment);
}

async function loadItems({ quiet = false } = {}) {
  if (!state.dataset) return;
  if (!quiet) {
    elements["empty-state"].hidden = true;
    renderGrid([], { skeletons: 8 });
  }
  const params = new URLSearchParams({
    split: state.split,
    page: state.page,
    page_size: state.pageSize,
    q: state.query,
  });
  const payload = await api(`/api/datasets/${state.dataset.id}/items?${params}`);
  state.split = payload.split;
  setDatasetSummary(payload.dataset);
  state.page = payload.page;
  state.pages = payload.pages;
  state.visibleItems = payload.items;
  state.totalItems = payload.total;
  const processing = BUSY_STATUSES.includes(payload.dataset.status);
  elements["extraction-banner"].hidden = !processing;
  elements["extraction-message"].textContent = payload.dataset.message || "Images will appear as soon as image-label pairs are ready.";
  renderGrid(payload.items, { skeletons: processing ? Math.max(3, Math.min(8, state.pageSize - payload.items.length)) : 0 });
  elements["empty-state"].hidden = payload.items.length > 0 || processing;
  if (!payload.items.length) {
    elements["empty-state"].querySelector("h2").textContent = payload.dataset.status === "extracting" ? "Dataset is still extracting" : "No images in this view";
    elements["empty-state"].querySelector("p").textContent = payload.dataset.status === "extracting"
      ? "This page refreshes automatically. Images will appear without waiting for the whole ZIP to extract."
      : "Try another split or clear the filename search.";
  }
  elements.pagination.hidden = payload.total === 0;
  renderUnlabeledBar(payload);
  renderIssuesBar(payload);
  renderPagination(payload);
}

function goToPage(page) {
  const target = Math.max(1, Math.min(state.pages, Number(page) || 1));
  if (target === state.page) return;
  state.page = target;
  void loadItems();
}

function renderPagination(payload) {
  const { start, end } = itemRange(payload.page, payload.page_size, payload.total);
  elements["item-range"].textContent = `${formatCount(start)}–${formatCount(end)}`;
  elements["pagination-total"].textContent = formatCount(payload.total);
  elements["page-indicator"].textContent = `/ ${formatCount(payload.pages)}`;
  elements["go-page"].max = String(payload.pages);
  elements["go-page"].value = String(payload.page);
  for (const id of ["first-page", "previous-page"]) elements[id].disabled = payload.page <= 1;
  for (const id of ["next-page", "last-page"]) elements[id].disabled = payload.page >= payload.pages;

  elements["page-numbers"].replaceChildren();
  for (const token of paginationTokens(payload.page, payload.pages)) {
    if (token === "…") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "page-ellipsis";
      ellipsis.textContent = token;
      elements["page-numbers"].append(ellipsis);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = `page-number ${token === payload.page ? "active" : ""}`;
    button.textContent = token;
    button.setAttribute("aria-label", `Page ${token}`);
    if (token === payload.page) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => goToPage(token));
    elements["page-numbers"].append(button);
  }
}

function setSplit(split) {
  state.split = split;
  state.page = 1;
  for (const button of document.querySelectorAll(".stat")) {
    const active = button.dataset.split === split;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  void loadItems();
}

function prepareZipUpload(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".zip")) return toast("Please select a .zip file.", "error");
  const baseName = file.name.replace(/\.zip$/i, "");
  state.pendingUpload = file;
  elements["import-file-name"].textContent = file.name;
  elements["import-file-size"].textContent = formatBytes(file.size);
  elements["import-dataset-name"].value = baseName;
  elements["import-folder-name"].value = baseName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\.+$/, "").slice(0, 100);
  elements["folder-suggestion"].hidden = true;
  elements["import-dialog"].showModal();
  elements["import-dataset-name"].focus();
  elements["import-dataset-name"].select();
}

function startZipUpload(file, datasetName, folderName) {
  elements["upload-panel"].hidden = false;
  raiseToTop(elements["upload-panel"]);
  elements["upload-title"].textContent = `Uploading ${file.name}`;
  elements["upload-progress"].value = 0;
  elements["upload-detail"].textContent = "0%";

  const xhr = new XMLHttpRequest();
  state.uploadXhr = xhr;
  elements["upload-panel"].dataset.state = "busy";
  elements["job-cancel"].hidden = false;
  elements["job-cancel"].dataset.jobId = "upload";
  xhr.open("POST", "/api/import");
  xhr.setRequestHeader("content-type", "application/zip");
  xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
  xhr.setRequestHeader("x-dataset-name", encodeURIComponent(datasetName));
  xhr.setRequestHeader("x-import-folder", encodeURIComponent(folderName));
  xhr.upload.onprogress = (event) => {
    if (!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    elements["upload-progress"].value = percent;
    elements["upload-detail"].textContent = `${percent}%, ${formatBytes(event.loaded)} of ${formatBytes(event.total)}`;
  };
  xhr.onabort = () => {
    state.uploadXhr = null;
    elements["upload-panel"].hidden = true;
    elements["start-import"].disabled = false;
    toast("Upload cancelled. Nothing was imported.");
  };
  xhr.onerror = () => {
    state.uploadXhr = null;
    elements["upload-panel"].hidden = true;
    elements["start-import"].disabled = false;
    toast("Upload failed. The original ZIP was not changed.", "error");
  };
  xhr.onload = async () => {
    state.uploadXhr = null;
    elements["job-cancel"].hidden = true;
    try {
      const payload = JSON.parse(xhr.responseText || "{}");
      if (xhr.status < 200 || xhr.status >= 300) throw new Error(payload.error || "Upload failed.");
      elements["upload-title"].textContent = "Upload complete. Extracting…";
      elements["upload-detail"].textContent = `Images appear in ${folderName} as they are extracted.`;
      if (payload.folder_name_adjusted) toast(`That folder already existed, so this import was saved as “${payload.import_folder_name}”.`);
      await loadDatasets(payload.dataset.id);
      elements["dataset-select"].value = payload.dataset.id;
      await selectDataset(payload.dataset.id);
      pollJob(payload.job.id, true);
      state.pendingUpload = null;
    } catch (error) {
      elements["upload-panel"].hidden = true;
      toast(error.message, "error");
      if (state.pendingUpload && !elements["import-dialog"].open) elements["import-dialog"].showModal();
    } finally {
      elements["start-import"].disabled = false;
    }
  };
  xhr.send(file);
}

async function openFolderDirectly(cleanPath) {
  const payload = await api("/api/datasets/open", {
    method: "POST",
    body: JSON.stringify({ path: cleanPath }),
  });
  await loadDatasets(payload.dataset.id);
  elements["dataset-select"].value = payload.dataset.id;
  await selectDataset(payload.dataset.id);
}

const folderDialog = { path: null, nameTouched: false };

function folderMode() {
  return elements["open-folder-form"].querySelector('input[name="folder-mode"]:checked')?.value || "copy";
}

function updateFolderMode() {
  const copy = folderMode() === "copy";
  elements["folder-copy-fields"].hidden = !copy;
  elements["folder-original-warning"].hidden = copy;
  elements["confirm-open-folder"].textContent = copy ? "Copy and open" : "Open original folder";
}

/** Asks whether to work on a copy (default) or on the original folder before opening it. */
async function openFolderPath(folderPath, { preferCopy = true } = {}) {
  const cleanPath = String(folderPath || "").trim();
  if (!cleanPath) return toast("Paste a dataset folder path first.", "error");
  const { folder } = await api("/api/folders/inspect", { method: "POST", body: JSON.stringify({ path: cleanPath }) });
  if (folder.managed_import) return openFolderDirectly(folder.path);
  folderDialog.path = folder.path;
  elements["folder-dialog-name"].textContent = folder.name;
  elements["folder-dialog-path"].textContent = folder.path;
  elements["folder-dialog-path"].title = folder.path;
  elements["folder-dialog-stats"].textContent = `${formatCount(folder.images)} images, ${formatBytes(folder.bytes)}`;
  elements["folder-copy-name"].value = `${folder.name} (copy)`;
  elements["folder-copy-folder"].value = folder.name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").slice(0, 100);
  const radios = elements["open-folder-form"].querySelectorAll('input[name="folder-mode"]');
  radios.forEach((radio) => { radio.checked = radio.value === (preferCopy ? "copy" : "original"); });
  updateFolderMode();
  elements["open-folder-dialog"].showModal();
}

async function submitOpenFolder(event) {
  event.preventDefault();
  if (!folderDialog.path) return;
  elements["confirm-open-folder"].disabled = true;
  try {
    if (folderMode() === "original") {
      elements["open-folder-dialog"].close();
      await openFolderDirectly(folderDialog.path);
      return;
    }
    const payload = await api("/api/datasets/open", {
      method: "POST",
      body: JSON.stringify({
        path: folderDialog.path,
        copy: true,
        name: elements["folder-copy-name"].value,
        folder_name: elements["folder-copy-folder"].value,
      }),
    });
    elements["open-folder-dialog"].close();
    if (payload.folder_name_adjusted) toast(`That working folder already existed, so “${payload.import_folder_name}” is used.`);
    showActivity({ title: "Making a working copy", detail: "Counting files…", percent: 2, cancelJobId: payload.job.id });
    await loadDatasets(payload.dataset.id);
    elements["dataset-select"].value = payload.dataset.id;
    await selectDataset(payload.dataset.id);
    pollJob(payload.job.id, true);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["confirm-open-folder"].disabled = false;
  }
}

function renderOriginalBanner(dataset) {
  const show = Boolean(dataset?.original_folder);
  elements["original-banner"].hidden = !show;
  if (show) elements["original-banner-path"].textContent = dataset.root;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function describeTransfer(job) {
  if (!job.bytes_done) return "";
  const parts = [`${formatBytes(job.bytes_done)}${job.bytes_total ? ` of ${formatBytes(job.bytes_total)}` : ""}`];
  if (job.bytes_per_second) parts.push(`${formatBytes(job.bytes_per_second)}/s`);
  if (job.eta_seconds) parts.push(`${formatDuration(job.eta_seconds)} left`);
  return parts.join(", ");
}

function jobPercent(job) {
  if (job.phase === "huggingface-download" && job.bytes_total) return Math.min(100, Math.round((job.bytes_done / job.bytes_total) * 100));
  return job.total ? Math.min(100, Math.round((job.current / job.total) * 100)) : 4;
}

const HF_PHASE_TITLES = {
  queued: "Connecting to Hugging Face",
  "huggingface-listing": "Listing repository files",
  "huggingface-download": "Downloading from Hugging Face",
  validating: "Checking ZIP paths",
  extracting: "Extracting archive",
  indexing: "Indexing images",
  "signature-validation": "Verifying signature labels",
};

function showActivity({ title, detail, percent = null, cancelJobId = null, done = false }) {
  elements["upload-panel"].hidden = false;
  raiseToTop(elements["upload-panel"]);
  elements["upload-panel"].dataset.state = done ? "done" : "busy";
  elements["upload-title"].textContent = title;
  elements["upload-detail"].textContent = detail;
  if (percent !== null) elements["upload-progress"].value = percent;
  elements["job-cancel"].hidden = !cancelJobId;
  elements["job-cancel"].dataset.jobId = cancelJobId || "";
}

const STAGE_WEIGHT = { check: 5, copy: 25, zip: 20, hash: 15, upload: 30, commit: 3, cleanup: 2 };
const STAGE_ICON = {
  done: '<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"/></svg>',
  skipped: '<svg viewBox="0 0 24 24"><path d="M5 12h12m-4-5 5 5-5 5"/></svg>',
  failed: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
  cancelled: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};

function preparePublishDialog() {
  elements["export-progress-dialog"].classList.add("is-publish");
  elements["export-progress-title"].textContent = "Publishing to Hugging Face";
  elements["export-progress-detail"].textContent = "Starting…";
  elements["export-progress"].value = 2;
  elements["publish-stages"].hidden = false;
  elements["publish-stages"].replaceChildren();
  elements["publish-actions"].hidden = false;
  elements["cancel-publish"].hidden = false;
  elements["cancel-publish"].disabled = false;
  elements["close-publish"].hidden = true;
  elements["publish-open-hub"].hidden = true;
  elements["export-progress-hint"].textContent = "You can keep working in another tab. If the dashboard closes, the built ZIP is reused next time.";
}

function prepareExportDialog() {
  elements["export-progress-dialog"].classList.remove("is-publish");
  elements["export-progress-title"].textContent = "Exporting dataset";
  elements["publish-stages"].hidden = true;
  elements["publish-actions"].hidden = true;
  elements["export-progress-hint"].textContent = "Keep this tab open until the export finishes.";
}

function renderPublishProgress(job) {
  const stages = job.stages || [];
  elements["cancel-publish"].dataset.jobId = job.id;
  const list = elements["publish-stages"];
  list.replaceChildren();
  let percent = 0;
  for (const stage of stages) {
    const weight = STAGE_WEIGHT[stage.id] || 0;
    if (["done", "skipped"].includes(stage.status)) percent += weight;
    else if (stage.status === "running" && stage.total) percent += weight * Math.min(1, (stage.current || 0) / stage.total);
    const item = document.createElement("li");
    item.className = "pstage";
    item.dataset.status = stage.status;
    const icon = document.createElement("span");
    icon.className = "pstage-icon";
    icon.innerHTML = STAGE_ICON[stage.status] || "";
    const copy = document.createElement("div");
    copy.className = "pstage-copy";
    const label = document.createElement("strong");
    label.textContent = stage.label + (stage.status === "skipped" ? " (skipped)" : "");
    copy.append(label);
    if (stage.detail) {
      const detail = document.createElement("small");
      detail.textContent = stage.detail;
      copy.append(detail);
    }
    if (stage.status === "running" && stage.total) {
      const bar = document.createElement("progress");
      bar.className = "bar";
      bar.max = stage.total;
      bar.value = stage.current || 0;
      copy.append(bar);
    }
    item.append(icon, copy);
    list.append(item);
  }
  elements["export-progress"].value = job.status === "completed" ? 100 : Math.max(2, Math.round(percent));
  const running = stages.find((stage) => stage.status === "running");
  const finished = !["queued", "running"].includes(job.status);
  elements["export-progress-title"].textContent = job.status === "completed" ? "Published to Hugging Face"
    : job.status === "failed" ? "Publishing stopped" : job.status === "cancelled" ? "Publishing cancelled" : "Publishing to Hugging Face";
  elements["export-progress-detail"].textContent = finished ? job.message : running ? `${running.label}…` : "Working…";
  elements["cancel-publish"].hidden = finished;
  elements["close-publish"].hidden = !finished;
  elements["publish-open-hub"].hidden = !job.hub_url;
  if (job.hub_url) elements["publish-open-hub"].href = job.hub_url;
}

async function pollJob(jobId, refreshDataset = false) {
  try {
    const { job } = await api(`/api/jobs/${jobId}`);
    const progress = job.total && job.type !== "huggingface-import" ? ` (${formatCount(job.current)} / ${formatCount(job.total)})` : "";
    elements["job-status"].textContent = `${job.message}${progress}`;
    if (job.type === "export") {
      elements["export-progress"].value = jobPercent(job);
      elements["export-progress-detail"].textContent = `${job.message}${progress}`;
    }
    if (job.type === "huggingface-export") renderPublishProgress(job);
    if (["huggingface-import", "import", "copy"].includes(job.type) && ["queued", "running"].includes(job.status)) {
      const transfer = job.phase === "huggingface-download" ? describeTransfer(job) : "";
      showActivity({
        title: job.type === "copy" ? (job.phase === "indexing" ? "Indexing images" : "Making a working copy") : job.type === "import" && job.phase === "queued" ? "Preparing ZIP" : HF_PHASE_TITLES[job.phase] || (job.type === "import" ? "Importing ZIP" : "Importing from Hugging Face"),
        detail: transfer && job.import_mode === "folder" ? `${job.message}, ${formatBytes(job.bytes_per_second || 0)}/s${job.eta_seconds ? `, ${formatDuration(job.eta_seconds)} left` : ""}` : transfer || (job.total ? `${job.message} (${formatCount(job.current)} / ${formatCount(job.total)})` : job.message),
        percent: jobPercent(job),
        cancelJobId: job.cancellable && ["queued", "huggingface-listing", "huggingface-download", "validating", "extracting"].includes(job.phase) ? job.id : null,
      });
    }
    if (["queued", "running"].includes(job.status)) {
      setTimeout(() => pollJob(jobId, refreshDataset), 1000);
      return;
    }
    if (job.status === "completed") {
      if (job.type === "export" && elements["export-progress-dialog"].open) elements["export-progress-dialog"].close();
      if (["huggingface-import", "import", "copy"].includes(job.type)) {
        showActivity({ title: job.type === "copy" ? "Working copy ready" : "Import complete", detail: job.message, percent: 100, done: true });
        setTimeout(() => { elements["upload-panel"].hidden = true; }, 3000);
      }
      elements["job-status"].textContent = job.hub_url ? `Published: ${job.hub_url}` : job.output_path ? `Saved to ${job.output_path}` : job.message;
      toast(job.type === "huggingface-export" ? "Dataset published to Hugging Face." : job.type === "copy" ? "Working copy ready. The original folder was not changed." : job.output_path ? "Dataset export completed." : "Dataset import completed.");
      if (["export", "huggingface-export"].includes(job.type) && job.dataset_id) void offerTrashCleanup(job.dataset_id);
      if (refreshDataset && state.dataset) {
        await loadDatasets(state.dataset.id);
        await loadItems({ quiet: true });
      }
    } else if (job.status === "cancelled" && job.type === "huggingface-export") {
      toast(job.message);
    } else if (job.status === "cancelled") {
      elements["upload-panel"].hidden = true;
      toast(job.message);
      clearTimeout(state.refreshTimer);
      await loadDatasets();
      if (!state.datasets.some((dataset) => dataset.id === state.dataset?.id)) {
        clearTimeout(state.refreshTimer);
        state.activeDatasetId = null;
        setDatasetSummary(null);
        showWelcome();
      }
    } else {
      if (job.type === "export" && elements["export-progress-dialog"].open) elements["export-progress-dialog"].close();
      if (["huggingface-import", "import", "copy"].includes(job.type)) elements["upload-panel"].hidden = true;
      toast(job.message, "error");
      if (refreshDataset && state.dataset) await loadDatasets(state.dataset.id).catch(() => {});
    }
  } catch (error) {
    if (elements["export-progress-dialog"].open) elements["export-progress-dialog"].close();
    toast(error.message, "error");
  }
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value)));
}

function normalizeBox(box) {
  const width = clamp(box.width, 0.001, 1);
  const height = clamp(box.height, 0.001, 1);
  return {
    class_id: Math.max(0, Math.trunc(Number(box.class_id) || 0)),
    x_center: clamp(box.x_center, width / 2, 1 - width / 2),
    y_center: clamp(box.y_center, height / 2, 1 - height / 2),
    width,
    height,
  };
}

function boxPixels(box) {
  const { width, height } = sourceDimensions();
  return {
    x: (box.x_center - box.width / 2) * width,
    y: (box.y_center - box.height / 2) * height,
    width: box.width * width,
    height: box.height * height,
  };
}

function sourceDimensions() {
  return {
    width: state.image?.naturalWidth || 800,
    height: state.image?.naturalHeight || 600,
  };
}

function sizeCanvas() {
  const canvas = elements["annotation-canvas"];
  const source = sourceDimensions();
  const oriented = orientedSize(source.width, source.height, state.orientation);
  canvas.width = oriented.width;
  canvas.height = oriented.height;
}

function applyOrientationTransform(context) {
  const { width, height } = sourceDimensions();
  if (state.orientation === 90) {
    context.translate(height, 0);
    context.rotate(Math.PI / 2);
  } else if (state.orientation === 180) {
    context.translate(width, height);
    context.rotate(Math.PI);
  } else if (state.orientation === 270) {
    context.translate(0, width);
    context.rotate(-Math.PI / 2);
  }
}

function setOrientation(value) {
  state.orientation = normalizeOrientation(value);
  elements["rotation-value"].value = `${state.orientation}°`;
  elements["rotation-value"].textContent = `${state.orientation}°`;
  sizeCanvas();
  drawCanvas();
}

function drawCanvas() {
  const canvas = elements["annotation-canvas"];
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const source = sourceDimensions();
  const displayScale = canvas.getBoundingClientRect().width / Math.max(1, canvas.width);
  const lineWidth = Math.max(2 / Math.max(displayScale, .01), 1);
  const handleSize = Math.max(9 / Math.max(displayScale, .01), 5);

  context.save();
  applyOrientationTransform(context);
  if (state.image) context.drawImage(state.image, 0, 0, source.width, source.height);

  state.boxes.forEach((box, index) => {
    const pixel = boxPixels(box);
    const selected = index === state.selectedBox;
    context.save();
    context.strokeStyle = selected ? "#f4b942" : "#2bd184";
    context.fillStyle = selected ? "rgba(244,185,66,.10)" : "rgba(43,209,132,.08)";
    context.lineWidth = lineWidth;
    context.fillRect(pixel.x, pixel.y, pixel.width, pixel.height);
    context.strokeRect(pixel.x, pixel.y, pixel.width, pixel.height);

    const label = state.dataset?.class_names?.[box.class_id] || `class ${box.class_id}`;
    const fontSize = Math.max(12 / Math.max(displayScale, .01), 8);
    context.font = `600 ${fontSize}px sans-serif`;
    const labelWidth = context.measureText(label).width + 10 / Math.max(displayScale, .01);
    const labelHeight = fontSize + 7 / Math.max(displayScale, .01);
    context.fillStyle = selected ? "#d79727" : "#16835b";
    context.fillRect(pixel.x, Math.max(0, pixel.y - labelHeight), labelWidth, labelHeight);
    context.fillStyle = "white";
    context.fillText(label, pixel.x + 5 / Math.max(displayScale, .01), Math.max(fontSize, pixel.y - 5 / Math.max(displayScale, .01)));

    if (selected) {
      context.fillStyle = "white";
      context.strokeStyle = "#d79727";
      for (const [x, y] of [[pixel.x, pixel.y], [pixel.x + pixel.width, pixel.y], [pixel.x, pixel.y + pixel.height], [pixel.x + pixel.width, pixel.y + pixel.height]]) {
        context.fillRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
        context.strokeRect(x - handleSize / 2, y - handleSize / 2, handleSize, handleSize);
      }
    }
    context.restore();
  });
  context.restore();
}

function renderBoxList() {
  elements["box-count"].textContent = state.boxes.length;
  elements["box-list"].replaceChildren();
  state.boxes.forEach((box, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `box-row ${index === state.selectedBox ? "active" : ""}`;
    const name = state.dataset?.class_names?.[box.class_id] || `Class ${box.class_id}`;
    const title = document.createElement("span");
    title.textContent = `${index + 1}. ${name}`;
    const detail = document.createElement("small");
    detail.textContent = `${Math.round(box.width * 100)}×${Math.round(box.height * 100)}%`;
    button.append(title, detail);
    button.addEventListener("click", () => selectBox(index));
    elements["box-list"].append(button);
  });
  updateBoxFields();
  drawCanvas();
}

function selectBox(index) {
  state.selectedBox = index;
  renderBoxList();
}

function updateBoxFields() {
  const box = state.boxes[state.selectedBox];
  elements["box-fields"].hidden = !box;
  if (!box) return;
  elements["box-class"].value = String(box.class_id);
  elements["box-x"].value = box.x_center.toFixed(4);
  elements["box-y"].value = box.y_center.toFixed(4);
  elements["box-width"].value = box.width.toFixed(4);
  elements["box-height"].value = box.height.toFixed(4);
}

function setDirty(value = true) {
  state.dirty = value;
  elements["save-state"].classList.toggle("dirty", value);
  elements["save-state"].classList.toggle("saved", !value);
  elements["save-state"].lastChild.textContent = value ? "Unsaved changes" : "All changes saved";
}

function updateUndoAvailability() {
  elements["undo-action"].disabled = state.undoStack.length === 0 || state.editorLoading;
}

function pushUndoSnapshot() {
  state.undoStack.push(createBoxSnapshot(state.boxes, state.selectedBox));
  if (state.undoStack.length > 50) state.undoStack.shift();
  updateUndoAvailability();
}

function undoBoxes() {
  const snapshot = state.undoStack.pop();
  if (!snapshot) return;
  const restored = restoreBoxSnapshot(snapshot);
  state.boxes = restored.boxes;
  state.selectedBox = restored.selectedBox;
  setDirty();
  updateUndoAvailability();
  renderBoxList();
}

function setTool(tool) {
  state.tool = tool;
  for (const name of ["select", "draw"]) {
    const button = elements[`${name}-tool`];
    const active = name === tool;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  elements["annotation-canvas"].style.cursor = tool === "draw" ? "crosshair" : "default";
}

async function openEditor(itemId) {
  const requestToken = ++state.imageRequestToken;
  const preview = state.visibleItems.find((item) => item.id === itemId);
  if (!elements["editor-dialog"].open) state.orientation = 0;
  state.editorLoading = true;
  state.undoStack = [];
  updateUndoAvailability();
  state.currentItem = preview || { id: itemId, name: "Loading…", relative: "", split: state.split };
  state.image = null;
  state.boxes = [];
  state.selectedBox = -1;
  state.dirty = false;
  elements["editor-title"].textContent = state.currentItem.name;
  elements["editor-path"].textContent = state.currentItem.relative || "Loading image and annotation data…";
  elements["editor-split"].textContent = String(state.currentItem.split || state.split).toUpperCase();
  elements["label-warning"].hidden = true;
  elements["box-list"].replaceChildren();
  elements["box-count"].textContent = "0";
  elements["box-fields"].hidden = true;
  setDirty(false);
  setOrientation(state.orientation);
  showCanvasLoading("Loading image and labels…");
  if (!elements["editor-dialog"].open) elements["editor-dialog"].showModal();
  updateEditorNavigation();

  try {
    const imageUrl = preview?.image_url || `/api/datasets/${state.dataset.id}/items/${itemId}/image`;
    const imagePromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("The image could not be decoded."));
      image.src = imageUrl;
    });
    const [payload, image] = await Promise.all([
      api(`/api/datasets/${state.dataset.id}/items/${itemId}`),
      imagePromise,
    ]);
    if (requestToken !== state.imageRequestToken) return;
    state.currentItem = payload.item;
    state.image = image;
    state.boxes = payload.boxes.map(normalizeBox);
    state.currentLabelState = payload.label_state || (payload.boxes.length ? "labeled" : "missing");
    state.undoStack = [];
    updateUndoAvailability();
    state.selectedBox = state.boxes.length ? 0 : -1;
    state.dirty = false;
    elements["editor-title"].textContent = payload.item.name;
    elements["editor-path"].textContent = payload.item.relative;
    elements["editor-split"].textContent = payload.item.split.toUpperCase();
    const classNotes = (payload.label_issues || [])
      .filter((issue) => ["unknown-class", "other-class"].includes(issue.code))
      .map((issue) => issue.code === "unknown-class"
        ? `${issue.count} box(es) use a class ID that data.yaml does not list. Pick a valid class for them and save.`
        : `${issue.count} box(es) use a class that is not named signature. Change their class or remove them, then save.`);
    const warnings = [...payload.label_errors, ...classNotes];
    elements["label-warning"].hidden = warnings.length === 0;
    elements["label-warning"].textContent = warnings.length ? `${warnings.join(" ")} Saving rewrites this label file in clean YOLO format.` : "";
    setDirty(false);

    refreshClassOptions(payload.class_names);

    sizeCanvas();
    renderBoxList();
    elements["canvas-loading"].hidden = true;
    prefetchAdjacentImages();
  } catch (error) {
    if (requestToken === state.imageRequestToken) {
      showCanvasLoading(error.message || "Image and labels could not be loaded.", false);
      toast(error.message, "error");
    }
  } finally {
    if (requestToken === state.imageRequestToken) {
      state.editorLoading = false;
      updateEditorNavigation();
    }
  }
}

function showCanvasLoading(message, animated = true) {
  elements["canvas-loading"].replaceChildren();
  if (animated) {
    const loader = document.createElement("span");
    loader.className = "loader";
    elements["canvas-loading"].append(loader);
  }
  elements["canvas-loading"].append(document.createTextNode(message));
  elements["canvas-loading"].hidden = false;
}

function currentVisibleIndex() {
  return state.visibleItems.findIndex((item) => item.id === state.currentItem?.id);
}

function updateEditorNavigation() {
  const index = currentVisibleIndex();
  const position = index >= 0 ? ((state.page - 1) * state.pageSize) + index + 1 : 0;
  elements["editor-position"].textContent = position ? `${formatCount(position)} of ${formatCount(state.totalItems)}` : `— of ${formatCount(state.totalItems)}`;
  const atStart = state.page <= 1 && index <= 0;
  const atEnd = state.page >= state.pages && (index < 0 || index >= state.visibleItems.length - 1);
  elements["editor-previous"].disabled = state.navigationLock || state.editorLoading || atStart;
  elements["editor-next"].disabled = state.navigationLock || state.editorLoading || atEnd;
}

function prefetchAdjacentImages() {
  const index = currentVisibleIndex();
  for (const adjacentIndex of [index - 1, index + 1]) {
    const item = state.visibleItems[adjacentIndex];
    if (!item) continue;
    const image = new Image();
    image.decoding = "async";
    image.src = item.image_url;
  }
}

async function navigateEditor(direction) {
  if (state.navigationLock || state.editorLoading || !state.currentItem) return;
  state.navigationLock = true;
  updateEditorNavigation();
  try {
    if (state.dirty) {
      const saved = await saveLabels({ silent: true });
      if (!saved) return;
    }
    let index = currentVisibleIndex();
    let target = state.visibleItems[index + direction];
    if (!target) {
      const nextPage = state.page + direction;
      if (nextPage < 1 || nextPage > state.pages) return;
      state.page = nextPage;
      await loadItems({ quiet: true });
      index = direction > 0 ? 0 : state.visibleItems.length - 1;
      target = state.visibleItems[index];
    }
    if (target) await openEditor(target.id);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    state.navigationLock = false;
    updateEditorNavigation();
  }
}

function pointerPosition(event) {
  const canvas = elements["annotation-canvas"];
  const rect = canvas.getBoundingClientRect();
  const rotatedX = clamp((event.clientX - rect.left) / rect.width) * canvas.width;
  const rotatedY = clamp((event.clientY - rect.top) / rect.height) * canvas.height;
  const source = sourceDimensions();
  return viewToSource(rotatedX, rotatedY, source.width, source.height, state.orientation);
}

function boxFromCorners(x1, y1, x2, y2, classId = 0) {
  const source = sourceDimensions();
  const left = clamp(Math.min(x1, x2), 0, source.width);
  const right = clamp(Math.max(x1, x2), 0, source.width);
  const top = clamp(Math.min(y1, y2), 0, source.height);
  const bottom = clamp(Math.max(y1, y2), 0, source.height);
  return normalizeBox({
    class_id: classId,
    x_center: ((left + right) / 2) / source.width,
    y_center: ((top + bottom) / 2) / source.height,
    width: Math.max(1, right - left) / source.width,
    height: Math.max(1, bottom - top) / source.height,
  });
}

function hitTest(position) {
  const canvas = elements["annotation-canvas"];
  const displayScale = canvas.getBoundingClientRect().width / canvas.width;
  const tolerance = 12 / Math.max(displayScale, .01);
  for (let index = state.boxes.length - 1; index >= 0; index -= 1) {
    const pixel = boxPixels(state.boxes[index]);
    const corners = [
      ["nw", pixel.x, pixel.y], ["ne", pixel.x + pixel.width, pixel.y],
      ["sw", pixel.x, pixel.y + pixel.height], ["se", pixel.x + pixel.width, pixel.y + pixel.height],
    ];
    for (const [corner, x, y] of corners) {
      if (Math.abs(position.x - x) <= tolerance && Math.abs(position.y - y) <= tolerance) return { index, type: "resize", corner, pixel };
    }
    if (position.x >= pixel.x && position.x <= pixel.x + pixel.width && position.y >= pixel.y && position.y <= pixel.y + pixel.height) {
      return { index, type: "move", pixel };
    }
  }
  return null;
}

function onPointerDown(event) {
  if (!state.image) return;
  const canvas = elements["annotation-canvas"];
  canvas.setPointerCapture(event.pointerId);
  const position = pointerPosition(event);
  if (state.tool === "draw") {
    pushUndoSnapshot();
    const box = boxFromCorners(position.x, position.y, position.x + 1, position.y + 1, state.drawClass || 0);
    state.boxes.push(box);
    state.selectedBox = state.boxes.length - 1;
    state.pointerAction = { type: "draw", start: position, undoPushed: true };
    setDirty();
    renderBoxList();
    return;
  }
  const hit = hitTest(position);
  if (!hit) {
    state.selectedBox = -1;
    renderBoxList();
    return;
  }
  state.selectedBox = hit.index;
  if (hit.type === "move") {
    state.pointerAction = { type: "move", start: position, original: { ...state.boxes[hit.index] }, undoPushed: false };
  } else {
    const opposite = {
      nw: { x: hit.pixel.x + hit.pixel.width, y: hit.pixel.y + hit.pixel.height },
      ne: { x: hit.pixel.x, y: hit.pixel.y + hit.pixel.height },
      sw: { x: hit.pixel.x + hit.pixel.width, y: hit.pixel.y },
      se: { x: hit.pixel.x, y: hit.pixel.y },
    }[hit.corner];
    state.pointerAction = { type: "resize", opposite, classId: state.boxes[hit.index].class_id, undoPushed: false };
  }
  renderBoxList();
}

function onPointerMove(event) {
  if (!state.pointerAction || state.selectedBox < 0) return;
  const position = pointerPosition(event);
  const source = sourceDimensions();
  if (!state.pointerAction.undoPushed) {
    pushUndoSnapshot();
    state.pointerAction.undoPushed = true;
  }
  if (state.pointerAction.type === "draw") {
    state.boxes[state.selectedBox] = boxFromCorners(state.pointerAction.start.x, state.pointerAction.start.y, position.x, position.y, state.drawClass || 0);
  } else if (state.pointerAction.type === "resize") {
    state.boxes[state.selectedBox] = boxFromCorners(state.pointerAction.opposite.x, state.pointerAction.opposite.y, position.x, position.y, state.pointerAction.classId);
  } else if (state.pointerAction.type === "move") {
    const original = state.pointerAction.original;
    const dx = (position.x - state.pointerAction.start.x) / source.width;
    const dy = (position.y - state.pointerAction.start.y) / source.height;
    state.boxes[state.selectedBox] = normalizeBox({ ...original, x_center: original.x_center + dx, y_center: original.y_center + dy });
  }
  setDirty();
  updateBoxFields();
  drawCanvas();
}

function onPointerUp() {
  if (!state.pointerAction) return;
  state.pointerAction = null;
  renderBoxList();
}

function deleteSelectedBox() {
  if (state.selectedBox < 0) return;
  pushUndoSnapshot();
  state.boxes.splice(state.selectedBox, 1);
  state.selectedBox = Math.min(state.selectedBox, state.boxes.length - 1);
  setDirty();
  renderBoxList();
}

/** Fills the class pickers (selected box and "New boxes") from the dataset's class list. */
function refreshClassOptions(names) {
  const classNames = names?.length ? names : ["signature"];
  const maxUsed = Math.max(classNames.length - 1, ...state.boxes.map((box) => box.class_id));
  for (const id of ["box-class", "draw-class"]) {
    elements[id].replaceChildren();
    for (let index = 0; index <= (id === "box-class" ? maxUsed : classNames.length - 1); index += 1) {
      elements[id].append(new Option(`${index}: ${classNames[index] ?? `unknown class ${index}`}`, index));
    }
  }
  if (!Number.isInteger(state.drawClass) || state.drawClass >= classNames.length) {
    const signatureIndex = classNames.findIndex((name) => String(name).toLowerCase().includes("signature"));
    state.drawClass = signatureIndex >= 0 ? signatureIndex : 0;
  }
  elements["draw-class"].value = String(state.drawClass);
  updateBoxFields();
}

const classEditor = { names: [], counts: {} };

function renderClassEditor() {
  const list = elements["classes-list"];
  list.replaceChildren();
  classEditor.names.forEach((name, index) => {
    const row = document.createElement("div");
    row.className = "class-row";
    const id = document.createElement("span");
    id.className = "class-id";
    id.textContent = index;
    const input = document.createElement("input");
    input.className = `input${String(name).toLowerCase().includes("signature") ? " is-signature" : ""}`;
    input.value = name;
    input.maxLength = 100;
    input.setAttribute("aria-label", `Name of class ${index}`);
    input.addEventListener("input", () => {
      classEditor.names[index] = input.value;
      input.classList.toggle("is-signature", input.value.toLowerCase().includes("signature"));
      renderClassSuggestion();
    });
    const count = document.createElement("span");
    count.className = "class-count";
    const boxes = classEditor.counts[index] || 0;
    count.textContent = `${formatCount(boxes)} ${boxes === 1 ? "box" : "boxes"}`;
    row.append(id, input, count);
    const isLastUnused = index === classEditor.names.length - 1 && !boxes && classEditor.names.length > 1;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "class-remove";
    remove.title = isLastUnused ? "Remove this unused class" : "Only the last class can be removed, and only when no box uses it";
    remove.disabled = !isLastUnused;
    remove.style.visibility = isLastUnused ? "visible" : "hidden";
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.addEventListener("click", () => {
      classEditor.names.pop();
      renderClassEditor();
    });
    row.append(remove);
    list.append(row);
  });
  renderClassSuggestion();
}

function renderClassSuggestion() {
  const hasSignature = classEditor.names.some((name) => String(name).toLowerCase().includes("signature"));
  const entries = Object.entries(classEditor.counts).map(([id, count]) => [Number(id), count]).filter(([id]) => id < classEditor.names.length);
  const [mostUsed, boxes] = entries.sort((left, right) => right[1] - left[1])[0] || [0, 0];
  elements["classes-suggestion"].hidden = hasSignature || !classEditor.names.length;
  if (hasSignature) return;
  elements["classes-suggestion-text"].textContent = boxes
    ? `No class is named "signature". Most boxes (${formatCount(boxes)}) use class ${mostUsed}, "${classEditor.names[mostUsed]}".`
    : `No class is named "signature" yet.`;
  elements["classes-apply-suggestion"].dataset.index = String(mostUsed);
}

async function openClassesDialog() {
  if (!state.dataset) return toast("Choose a dataset first.", "error");
  try {
    const payload = await api(`/api/datasets/${state.dataset.id}/classes`);
    classEditor.names = [...(payload.names?.length ? payload.names : ["signature"])];
    classEditor.counts = payload.counts || {};
    elements["classes-original-note"].hidden = !payload.original_folder;
    renderClassEditor();
    elements["classes-dialog"].showModal();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function saveClasses(event) {
  event.preventDefault();
  elements["save-classes"].disabled = true;
  try {
    const payload = await api(`/api/datasets/${state.dataset.id}/classes`, { method: "PUT", body: JSON.stringify({ names: classEditor.names }) });
    elements["classes-dialog"].close();
    setDatasetSummary(payload.dataset);
    if (elements["editor-dialog"].open) {
      refreshClassOptions(payload.names);
      renderBoxList();
    }
    await loadItems({ quiet: true });
    toast("Classes saved to data.yaml.");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["save-classes"].disabled = false;
  }
}

function addCenteredBox() {
  pushUndoSnapshot();
  state.boxes.push({ class_id: state.drawClass || 0, x_center: .5, y_center: .5, width: .3, height: .2 });
  state.selectedBox = state.boxes.length - 1;
  setDirty();
  renderBoxList();
}

async function saveLabels({ silent = false } = {}) {
  if (!state.currentItem) return false;
  try {
    elements["save-labels"].disabled = true;
    elements["save-state"].textContent = "Saving…";
    const payload = await api(`/api/datasets/${state.dataset.id}/items/${state.currentItem.id}/labels`, {
      method: "PUT",
      body: JSON.stringify({ boxes: state.boxes.map(normalizeBox) }),
    });
    state.boxes = payload.boxes;
    state.currentLabelState = payload.label_state || state.currentLabelState;
    setDirty(false);
    if (!silent) toast("Annotations saved in YOLO/Roboflow format.");
    renderBoxList();
    if (["unlabeled", "issues"].includes(state.split)) await loadItems({ quiet: true });
    return true;
  } catch (error) {
    elements["save-state"].classList.add("dirty");
    elements["save-state"].lastChild.textContent = "Save failed";
    toast(error.message, "error");
    return false;
  } finally {
    elements["save-labels"].disabled = false;
  }
}

function showConfirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "danger", preview = null, note = "" }) {
  const dialog = elements["confirm-dialog"];
  if (dialog.open) dialog.close();
  elements["confirm-title"].textContent = title;
  elements["confirm-message"].textContent = message;
  elements["confirm-accept"].textContent = confirmLabel;
  elements["confirm-cancel"].textContent = cancelLabel;
  elements["confirm-accept"].className = `btn ${tone === "danger" ? "btn-danger" : "btn-ink"}`;
  elements["confirm-icon"].dataset.tone = tone;
  elements["confirm-icon"].innerHTML = tone === "danger"
    ? '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  elements["confirm-note"].textContent = note;
  elements["confirm-note"].hidden = !note;
  elements["confirm-preview"].hidden = !preview;
  if (preview) {
    elements["confirm-preview-image"].src = preview.image || "";
    elements["confirm-preview-image"].hidden = !preview.image;
    elements["confirm-image-name"].textContent = preview.imageName;
    elements["confirm-label-name"].textContent = preview.labelName;
    elements["confirm-label-state"].textContent = preview.labelState || "";
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      elements["confirm-accept"].removeEventListener("click", onAccept);
      elements["confirm-cancel"].removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onEscape);
      dialog.removeEventListener("close", onCancel);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onAccept = () => finish(true);
    const onCancel = () => finish(false);
    const onEscape = (event) => {
      event.preventDefault();
      finish(false);
    };
    elements["confirm-accept"].addEventListener("click", onAccept);
    elements["confirm-cancel"].addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onEscape);
    dialog.addEventListener("close", onCancel);
    dialog.showModal();
    (tone === "danger" && preview ? elements["confirm-accept"] : elements["confirm-cancel"]).focus();
  });
}

function labelStateText(boxCount, labelState) {
  if (labelState === "missing") return "no label file";
  if (!boxCount) return "empty";
  return `${boxCount} ${boxCount === 1 ? "box" : "boxes"}`;
}

const ISSUE_TEXT = {
  "invalid-rows": "Invalid rows",
  polygon: "Polygon rows",
  "unknown-class": "Unknown class",
  "other-class": "Non-signature class",
};

const ISSUE_SENTENCE = {
  "invalid-rows": (count) => `${formatCount(count)} with rows that are not valid YOLO (wrong number of values or coordinates outside 0 to 1)`,
  polygon: (count) => `${formatCount(count)} with segmentation polygons instead of boxes`,
  "unknown-class": (count) => `${formatCount(count)} with a class ID that data.yaml does not list`,
  "other-class": (count) => `${formatCount(count)} with boxes whose class is not signature`,
};

function renderIssuesBar(payload) {
  const show = payload.split === "issues" && payload.total > 0;
  elements["issues-bar"].hidden = !show;
  if (!show) return;
  const counts = payload.dataset.issue_counts || {};
  const parts = Object.entries(counts).map(([code, count]) => (ISSUE_SENTENCE[code] ? ISSUE_SENTENCE[code](count) : `${formatCount(count)} ${code}`));
  elements["issues-summary"].replaceChildren();
  const strong = document.createElement("b");
  strong.textContent = `${formatCount(payload.dataset.issues)} ${payload.dataset.issues === 1 ? "label file needs" : "label files need"} fixing`;
  const detail = document.createElement("span");
  detail.textContent = `${parts.length ? `: ${parts.join("; ")}.` : "."} Open an image, fix its boxes or classes and save. Saving rewrites the file in clean YOLO format, and fixed files leave this tab.`;
  elements["issues-summary"].append(strong, detail);
}

function renderUnlabeledBar(payload) {
  const show = payload.split === "unlabeled" && payload.total > 0 && !BUSY_STATUSES.includes(payload.dataset.status);
  elements["unlabeled-bar"].hidden = !show;
  if (!show) return;
  const { unlabeled = 0, unlabeled_empty: empty = 0, unlabeled_missing: missing = 0 } = payload.dataset;
  const parts = [];
  if (empty) parts.push(`${formatCount(empty)} with an empty label file`);
  if (missing) parts.push(`${formatCount(missing)} with no label file`);
  elements["unlabeled-summary"].innerHTML = "";
  const strong = document.createElement("b");
  strong.textContent = `${formatCount(unlabeled)} ${unlabeled === 1 ? "image has" : "images have"} no boxes`;
  elements["unlabeled-summary"].append(strong, parts.length ? `: ${parts.join(" and ")}.` : ".");
}

async function deleteAllUnlabeled() {
  if (!state.dataset) return;
  const count = Number(state.dataset.unlabeled || 0);
  if (!count) return;
  const label = `${formatCount(count)} unlabeled ${count === 1 ? "image" : "images"}`;
  const confirmed = await showConfirm({
    title: `Delete all ${label}?`,
    message: "Every image in this tab, from every split, is removed from the dataset, together with its label file if it has one.",
    confirmLabel: `Delete ${formatCount(count)} ${count === 1 ? "image" : "images"}`,
    cancelLabel: "Keep them",
    note: "They move to the trash. You can undo right after, or restore them later from Deleted images.",
  });
  if (!confirmed) return;
  elements["delete-unlabeled"].disabled = true;
  try {
    const result = await api(`/api/datasets/${state.dataset.id}/unlabeled/delete`, { method: "POST", body: "{}" });
    await loadDatasets(state.dataset.id);
    await loadItems({ quiet: true });
    void refreshTrashCount();
    const ids = result.trash_ids;
    const node = toast(`Deleted ${formatCount(result.deleted)} unlabeled ${result.deleted === 1 ? "image" : "images"}.`, "info", {
      actionLabel: "Undo",
      duration: 15000,
      onAction: async () => {
        try {
          const restored = await api("/api/trash/restore", { method: "POST", body: JSON.stringify({ ids }) });
          toast(`Restored ${formatCount(restored.restored)} ${restored.restored === 1 ? "image" : "images"}.`);
          await loadDatasets(state.dataset.id);
          await loadItems({ quiet: true });
          void refreshTrashCount();
        } catch (error) {
          toast(error.message, "error");
        }
      },
    });
    node.dataset.bulk = "unlabeled";
    if (result.failed?.length) toast(`${formatCount(result.failed.length)} images could not be deleted: ${result.failed[0].error}`, "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["delete-unlabeled"].disabled = false;
  }
}

/** After an export, offer to empty the trash: deleted images are never part of an export. */
async function offerTrashCleanup(datasetId) {
  let trash;
  try {
    trash = await api(`/api/trash?dataset_id=${encodeURIComponent(datasetId)}`);
  } catch {
    return;
  }
  if (!trash.total) return;
  const count = formatCount(trash.total);
  const plural = trash.total === 1 ? "image" : "images";
  const empty = await showConfirm({
    title: "Empty the trash as well?",
    message: `This dataset has ${count} deleted ${plural} in the trash. They are not in the export. Remove them for good to free disk space?`,
    confirmLabel: "Empty trash",
    cancelLabel: "Keep for now",
    note: `If you keep them, they are removed automatically ${trash.retention_days} days after they were deleted.`,
  });
  if (!empty) return;
  try {
    const { emptied } = await api(`/api/trash?dataset_id=${encodeURIComponent(datasetId)}`, { method: "DELETE", body: "{}" });
    toast(`Removed ${formatCount(emptied)} deleted ${emptied === 1 ? "image" : "images"} for good.`);
    void refreshTrashCount();
  } catch (error) {
    toast(error.message, "error");
  }
}

/** Removes trash entries past the retention period; runs every time the dashboard page loads. */
async function purgeExpiredTrash() {
  try {
    const { removed, retention_days: days } = await api("/api/trash/purge-expired", { method: "POST", body: "{}" });
    if (removed) toast(`Removed ${formatCount(removed)} deleted ${removed === 1 ? "image" : "images"} that had been in the trash for more than ${days} days.`);
  } catch {
    // Housekeeping only; never block the dashboard.
  }
}

async function refreshTrashCount() {
  if (!state.dataset) return;
  try {
    const { total } = await api(`/api/trash?dataset_id=${encodeURIComponent(state.dataset.id)}`);
    elements["trash-count"].textContent = formatCount(total);
  } catch {
    // The count is informational only.
  }
}

async function restoreDeleted(trashId, { reopen = false } = {}) {
  try {
    const payload = await api(`/api/trash/${encodeURIComponent(trashId)}/restore`, { method: "POST", body: "{}" });
    document.querySelectorAll(`.toast[data-trash-id="${CSS.escape(trashId)}"]`).forEach((node) => node.remove());
    toast(`Restored ${payload.name}.`);
    if (state.dataset?.id === payload.dataset_id) {
      await loadItems({ quiet: true });
      if (payload.dataset) setDatasetSummary(payload.dataset);
      if (reopen && elements["editor-dialog"].open) await openEditor(payload.item_id);
    }
    await refreshTrashCount();
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
}

function formatDeletedAt(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function renderTrashList() {
  const { entries, retention_days: days } = await api(`/api/trash?dataset_id=${encodeURIComponent(state.dataset.id)}`);
  elements["trash-retention"].textContent = `Items are removed for good automatically ${days} days after they were deleted.`;
  elements["trash-list"].replaceChildren();
  elements["trash-empty"].hidden = entries.length > 0;
  elements["trash-list"].hidden = entries.length === 0;
  elements["empty-trash"].disabled = entries.length === 0;
  elements["trash-count"].textContent = formatCount(entries.length);
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "trash-entry";
    const image = document.createElement("img");
    image.src = `/api/trash/${encodeURIComponent(entry.trash_id)}/image`;
    image.alt = "";
    image.loading = "lazy";
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = entry.name;
    const detail = document.createElement("small");
    detail.textContent = `${entry.relative}. Deleted ${formatDeletedAt(entry.deleted_at)}`;
    copy.append(name, detail);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.className = "btn btn-outline btn-sm";
    restore.textContent = "Restore";
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      if (await restoreDeleted(entry.trash_id)) await renderTrashList();
      else restore.disabled = false;
    });
    row.append(image, copy, restore);
    elements["trash-list"].append(row);
  }
}

async function deleteCurrentImage() {
  if (!state.currentItem || state.editorLoading) return;
  const item = state.currentItem;
  const preview = state.visibleItems.find((candidate) => candidate.id === item.id);
  const labelName = `${item.name.replace(/\.[^.]+$/, "")}.txt`;
  const confirmed = await showConfirm({
    title: "Delete this image and its label?",
    message: "Both files move to the trash and the reviewer opens the next image.",
    confirmLabel: "Delete and continue",
    cancelLabel: "Keep it",
    preview: {
      image: item.image_url || preview?.image_url,
      imageName: item.name,
      labelName,
      labelState: labelStateText(state.boxes.length, state.currentLabelState),
    },
    note: "You can undo right after, or restore it later from Deleted images.",
  });
  if (!confirmed) return;

  const index = Math.max(0, currentVisibleIndex());
  elements["delete-image"].disabled = true;
  try {
    const result = await api(`/api/datasets/${state.dataset.id}/items/${item.id}`, { method: "DELETE", body: "{}" });
    state.dirty = false;
    await loadItems({ quiet: true });
    let target = state.visibleItems[index] || state.visibleItems.at(-1);
    if (!target && state.page > 1) {
      state.page -= 1;
      await loadItems({ quiet: true });
      target = state.visibleItems.at(-1);
    }
    const undo = { actionLabel: "Undo", onAction: () => void restoreDeleted(result.trash_id, { reopen: true }) };
    let undoToast;
    if (target) {
      undoToast = toast(`Deleted ${item.name}.`, "info", undo);
      await openEditor(target.id);
    } else {
      elements["editor-dialog"].close();
      undoToast = toast(`Deleted ${item.name}. No images are left in this view.`, "info", undo);
    }
    undoToast.dataset.trashId = result.trash_id;
    void refreshTrashCount();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["delete-image"].disabled = false;
  }
}

async function requestEditorClose() {
  if (state.dirty) {
    const discard = await showConfirm({
      title: "Discard unsaved changes?",
      message: "Your bounding-box edits on this image have not been saved yet.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      tone: "warn",
    });
    if (!discard) return;
  }
  elements["editor-dialog"].close();
}

function updateSelectedBoxFromFields() {
  if (state.selectedBox < 0) return;
  pushUndoSnapshot();
  state.boxes[state.selectedBox] = normalizeBox({
    class_id: Number(elements["box-class"].value),
    x_center: Number(elements["box-x"].value),
    y_center: Number(elements["box-y"].value),
    width: Number(elements["box-width"].value),
    height: Number(elements["box-height"].value),
  });
  setDirty();
  renderBoxList();
}

function openRenameDialog() {
  if (!state.dataset) return;
  elements["rename-input"].value = state.dataset.name;
  elements["rename-dialog"].showModal();
  elements["rename-input"].focus();
  elements["rename-input"].select();
}

async function renameActiveDataset(event) {
  event.preventDefault();
  if (!state.dataset) return;
  const name = elements["rename-input"].value.trim();
  if (!name) return;
  elements["save-rename"].disabled = true;
  try {
    const payload = await api(`/api/datasets/${state.dataset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    const index = state.datasets.findIndex((dataset) => dataset.id === payload.dataset.id);
    if (index >= 0) state.datasets[index] = payload.dataset;
    state.exportNameDatasetId = null;
    setDatasetSummary(payload.dataset);
    await loadDatasets(payload.dataset.id);
    elements["dataset-message"].textContent = payload.message;
    elements["rename-dialog"].close();
    toast(payload.message);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["save-rename"].disabled = false;
  }
}

elements["dataset-select"].addEventListener("change", (event) => selectDataset(event.target.value));
elements["refresh-datasets"].addEventListener("click", async () => {
  await loadDatasets(state.dataset?.id);
  if (state.dataset) await loadItems({ quiet: true });
});
elements["reindex-button"].addEventListener("click", async () => {
  if (!state.dataset) return;
  await api(`/api/datasets/${state.dataset.id}/index`, { method: "POST", body: "{}" });
  toast("Background re-index started.");
  scheduleDatasetRefresh();
});
elements["zip-input"].addEventListener("change", (event) => {
  prepareZipUpload(event.target.files?.[0]);
  event.target.value = "";
});
elements["import-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.pendingUpload) return;
  const datasetName = elements["import-dataset-name"].value.trim();
  const folderName = elements["import-folder-name"].value.trim();
  if (!datasetName || !folderName) return;
  elements["start-import"].disabled = true;
  try {
    const resolution = await api("/api/import/suggest-folder", {
      method: "POST",
      body: JSON.stringify({ folder_name: folderName }),
    });
    if (!resolution.available) {
      elements["import-folder-name"].value = resolution.suggested;
      elements["folder-suggestion"].textContent = `“${resolution.requested}” already exists. Suggested available name: “${resolution.suggested}”. Review it, then click Upload & import again.`;
      elements["folder-suggestion"].hidden = false;
      toast(`Folder name changed to the available suggestion “${resolution.suggested}”.`);
      elements["import-folder-name"].focus();
      elements["import-folder-name"].select();
      return;
    }
    elements["folder-suggestion"].hidden = true;
    elements["import-dialog"].close();
    startZipUpload(state.pendingUpload, datasetName, resolution.suggested);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["start-import"].disabled = false;
  }
});
elements["import-folder-name"].addEventListener("input", () => { elements["folder-suggestion"].hidden = true; });
elements["cancel-import"].addEventListener("click", () => {
  state.pendingUpload = null;
  elements["import-dialog"].close();
});
elements["drop-zone"].addEventListener("keydown", (event) => {
  if (["Enter", " "].includes(event.key)) {
    event.preventDefault();
    elements["zip-input"].click();
  }
});
for (const eventName of ["dragenter", "dragover"]) {
  elements["drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    elements["drop-zone"].classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements["drop-zone"].addEventListener(eventName, (event) => {
    event.preventDefault();
    elements["drop-zone"].classList.remove("dragging");
  });
}
elements["drop-zone"].addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])];
  if (files.length !== 1) return toast("Drop one ZIP dataset at a time.", "error");
  prepareZipUpload(files[0]);
});
elements["welcome-folder-toggle"].addEventListener("click", () => {
  const expanded = elements["welcome-folder-toggle"].getAttribute("aria-expanded") === "true";
  elements["welcome-folder-toggle"].setAttribute("aria-expanded", String(!expanded));
  elements["welcome-folder-panel"].hidden = expanded;
  if (!expanded) elements["welcome-folder-path"].focus();
});
elements["welcome-open-folder"].addEventListener("click", async () => {
  try {
    await openFolderPath(elements["welcome-folder-path"].value);
  } catch (error) {
    toast(error.message, "error");
  }
});
elements["welcome-folder-path"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") elements["welcome-open-folder"].click();
});
const hfWizard = { step: "source", repository: null, selection: null };

function hfSetStep(step) {
  hfWizard.step = step;
  const choosing = step === "choose";
  elements["hf-step-source"].hidden = choosing;
  elements["hf-step-choose"].hidden = !choosing;
  elements["hf-back"].hidden = !choosing;
  elements["hf-inspect"].hidden = choosing;
  elements["start-hf-import"].hidden = !choosing;
  elements["hf-step-1"].classList.toggle("active", !choosing);
  elements["hf-step-1"].classList.toggle("done", choosing);
  elements["hf-step-2"].classList.toggle("active", choosing);
}

function openHfImport() {
  hfSetStep("source");
  elements["hf-import-dialog"].showModal();
  void checkHubConnection("hf-import-connection");
  elements["hf-import-repo"].focus();
  elements["hf-import-repo"].select();
}

function hfOptionNode({ value, icon, title, detail, tags = [], recommended = false }) {
  const label = document.createElement("label");
  label.className = "hf-option";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "hf-source";
  input.value = value;
  const iconNode = document.createElement("span");
  iconNode.className = "hf-option-icon";
  iconNode.innerHTML = icon;
  const copy = document.createElement("span");
  copy.className = "hf-option-copy";
  const titleNode = document.createElement("strong");
  titleNode.textContent = title;
  const detailNode = document.createElement("small");
  detailNode.textContent = detail;
  const tagRow = document.createElement("span");
  tagRow.className = "hf-option-tags";
  if (recommended) tags.unshift(["Recommended", "tag-accent"]);
  for (const [text, tone] of tags) {
    const tag = document.createElement("span");
    tag.className = `tag ${tone || ""}`;
    tag.textContent = text;
    tagRow.append(tag);
  }
  copy.append(titleNode, detailNode);
  if (tagRow.childElementCount) copy.append(tagRow);
  label.append(input, iconNode, copy);
  input.addEventListener("change", () => hfSelect(JSON.parse(value)));
  return label;
}

function hfSuggestName(selection) {
  const repoName = hfWizard.repository?.repo_id.split("/").at(-1) || "dataset";
  if (!selection) return repoName;
  if (selection.mode === "zip") return selection.path.split("/").at(-1).replace(/\.zip$/i, "") || repoName;
  return selection.path ? selection.path.split("/").at(-1) : repoName;
}

function hfSelect(selection) {
  const previousSuggestion = hfSuggestName(hfWizard.selection);
  hfWizard.selection = selection;
  const suggestion = hfSuggestName(selection);
  for (const id of ["hf-import-name", "hf-import-folder"]) {
    if (!elements[id].value || elements[id].value === previousSuggestion) elements[id].value = suggestion;
  }
  elements["start-hf-import"].disabled = !selection;
}

const ZIP_ICON = '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M11 3v2m0 2v2m0 2v2m-2 2h4v4h-4z"/></svg>';
const FOLDER_ICON = '<svg viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v10H3z"/></svg>';

function renderHfRepository(repository) {
  hfWizard.repository = repository;
  hfWizard.selection = null;
  elements["hf-import-name"].value = "";
  elements["hf-import-folder"].value = "";

  const summary = elements["hf-preview-summary"];
  summary.replaceChildren();
  const avatar = document.createElement("span");
  avatar.className = "repo-avatar";
  avatar.textContent = repository.repo_id.slice(0, 2);
  const copy = document.createElement("div");
  copy.className = "repo-copy";
  const link = document.createElement("a");
  link.href = repository.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `${repository.repo_id}${repository.path ? ` / ${repository.path}` : ""}`;
  const meta = document.createElement("div");
  meta.className = "repo-meta";
  const metaItems = [
    ["Revision", repository.revision],
    ["Files", formatCount(repository.total_files)],
    ["Size", formatBytes(repository.total_bytes)],
    ["Access", repository.authenticated ? "token" : "public"],
  ];
  for (const [name, value] of metaItems) {
    const item = document.createElement("span");
    item.append(`${name} `);
    const strong = document.createElement("b");
    strong.textContent = value;
    item.append(strong);
    meta.append(item);
  }
  copy.append(link, meta);
  summary.append(avatar, copy);

  const options = elements["hf-options"];
  options.replaceChildren();
  const recommended = repository.recommended ? JSON.stringify(repository.recommended) : null;
  for (const zip of repository.zips) {
    const value = JSON.stringify({ mode: "zip", path: zip.path });
    options.append(hfOptionNode({
      value,
      icon: ZIP_ICON,
      title: zip.path,
      detail: `ZIP archive, ${formatBytes(zip.size)}. Downloaded once and extracted on this computer.`,
      tags: [["Fastest", "tag-ok"]],
      recommended: value === recommended,
    }));
  }
  for (const folder of repository.folders) {
    const value = JSON.stringify({ mode: "folder", path: folder.path });
    const tags = folder.splits.map((split) => [split === "all" ? "unsplit" : split]);
    tags.push(folder.labels ? [`${formatCount(folder.labels)} labels`, "tag-ok"] : ["no labels", "tag-warn"]);
    if (folder.has_yaml) tags.push(["data.yaml", "tag-ok"]);
    options.append(hfOptionNode({
      value,
      icon: FOLDER_ICON,
      title: folder.path ? `${folder.path}/` : "Repository root (YOLO folders)",
      detail: `YOLO folder with ${formatCount(folder.images)} images, ${formatBytes(folder.bytes)}. Files download one by one.`,
      tags,
      recommended: value === recommended,
    }));
  }
  if (!options.childElementCount) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nothing importable was found at this location.";
    options.append(empty);
  }

  elements["hf-notes"].replaceChildren(...repository.notes.map((note) => {
    const paragraph = document.createElement("p");
    paragraph.textContent = note;
    return paragraph;
  }));
  elements["hf-notes"].hidden = repository.notes.length === 0;

  const preselect = recommended ? [...options.querySelectorAll("input")].find((input) => input.value === recommended) : options.querySelector("input");
  if (preselect) {
    preselect.checked = true;
    hfSelect(JSON.parse(preselect.value));
  } else {
    hfSelect(null);
  }
  hfSetStep("choose");
}

async function inspectHfRepository() {
  const directZip = elements["hf-import-zip-path"].value.trim();
  if (!elements["hf-import-repo"].value.trim()) {
    elements["hf-import-repo"].focus();
    return toast("Enter a Hugging Face dataset repository or link.", "error");
  }
  elements["hf-inspect"].disabled = true;
  const label = elements["hf-inspect"].lastChild;
  const original = label.textContent;
  label.textContent = " Searching…";
  try {
    if (directZip) {
      hfWizard.repository = { repo_id: elements["hf-import-repo"].value.trim(), revision: elements["hf-import-revision"].value.trim() || "main" };
      hfWizard.selection = { mode: "zip", path: directZip };
      await startHfImport();
      return;
    }
    const { repository } = await api("/api/huggingface/inspect", {
      method: "POST",
      body: JSON.stringify({
        repo_id: elements["hf-import-repo"].value,
        revision: elements["hf-import-revision"].value,
        token: elements["hf-import-token"].value,
      }),
    });
    if (repository.revision && repository.revision !== elements["hf-import-revision"].value.trim()) elements["hf-import-revision"].value = repository.revision;
    renderHfRepository(repository);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["hf-inspect"].disabled = false;
    label.textContent = original;
  }
}

async function startHfImport() {
  const selection = hfWizard.selection;
  if (!selection) return toast("Choose a ZIP archive or YOLO folder to import.", "error");
  const size = selection.mode === "zip" ? hfWizard.repository?.zips?.find((zip) => zip.path === selection.path)?.size : null;
  elements["start-hf-import"].disabled = true;
  showActivity({ title: "Connecting to Hugging Face", detail: selection.mode === "zip" ? `Preparing ${selection.path}…` : "Listing YOLO files…", percent: 2 });
  try {
    const payload = await api("/api/huggingface/import", {
      method: "POST",
      body: JSON.stringify({
        repo_id: hfWizard.repository?.repo_id || elements["hf-import-repo"].value,
        revision: elements["hf-import-revision"].value,
        mode: selection.mode,
        zip_path: selection.mode === "zip" ? selection.path : "",
        folder_path: selection.mode === "folder" ? selection.path : undefined,
        expected_size: size || undefined,
        dataset_name: elements["hf-import-name"].value,
        folder_name: elements["hf-import-folder"].value,
        token: elements["hf-import-token"].value,
      }),
    });
    elements["hf-import-token"].value = "";
    elements["hf-import-dialog"].close();
    if (payload.folder_name_adjusted) toast(`Import folder already existed, so “${payload.import_folder_name}” is being used.`);
    showActivity({ title: "Connecting to Hugging Face", detail: "Starting download…", percent: 2, cancelJobId: payload.job.id });
    await loadDatasets(payload.dataset.id);
    elements["dataset-select"].value = payload.dataset.id;
    await selectDataset(payload.dataset.id);
    pollJob(payload.job.id, true);
  } catch (error) {
    elements["upload-panel"].hidden = true;
    toast(error.message, "error");
  } finally {
    elements["start-hf-import"].disabled = false;
  }
}

elements["open-hf-import"].addEventListener("click", openHfImport);
elements["workspace-hf-import"].addEventListener("click", openHfImport);
elements["hf-back"].addEventListener("click", () => hfSetStep("source"));
elements["cancel-hf-import"].addEventListener("click", () => {
  elements["hf-import-token"].value = "";
  elements["hf-import-dialog"].close();
});
elements["hf-import-dialog"].addEventListener("close", () => { elements["hf-import-token"].value = ""; });
elements["hf-import-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (hfWizard.step === "source") await inspectHfRepository();
  else await startHfImport();
});
// Requests to /api/huggingface/import are only made from startHfImport above.
elements["job-cancel"].addEventListener("click", async () => {
  const jobId = elements["job-cancel"].dataset.jobId;
  if (!jobId) return;
  const uploading = jobId === "upload";
  const stop = await showConfirm({
    title: uploading ? "Cancel this upload?" : "Cancel this import?",
    message: uploading
      ? "The upload stops and the partly uploaded file is removed. Your original ZIP is not touched."
      : "The import stops and its partly filled working folder is removed.",
    confirmLabel: uploading ? "Cancel upload" : "Cancel import",
    cancelLabel: "Keep going",
    tone: "warn",
  });
  if (!stop) return;
  if (uploading) {
    state.uploadXhr?.abort();
    return;
  }
  elements["job-cancel"].disabled = true;
  try {
    await api(`/api/jobs/${jobId}/cancel`, { method: "POST", body: "{}" });
    elements["upload-title"].textContent = "Cancelling…";
  } catch (error) {
    toast(error.message, "error");
  } finally {
    elements["job-cancel"].disabled = false;
  }
});
elements["delete-unlabeled"].addEventListener("click", deleteAllUnlabeled);
elements["edit-classes"].addEventListener("click", openClassesDialog);
elements["inspector-edit-classes"].addEventListener("click", openClassesDialog);
elements["classes-form"].addEventListener("submit", saveClasses);
elements["cancel-classes"].addEventListener("click", () => elements["classes-dialog"].close());
elements["add-class"].addEventListener("click", () => {
  classEditor.names.push("");
  renderClassEditor();
  elements["classes-list"].querySelector(".class-row:last-child input")?.focus();
});
elements["classes-apply-suggestion"].addEventListener("click", () => {
  classEditor.names[Number(elements["classes-apply-suggestion"].dataset.index) || 0] = "signature";
  renderClassEditor();
});
elements["draw-class"].addEventListener("change", () => {
  state.drawClass = Number(elements["draw-class"].value) || 0;
});
elements["open-folder-form"].addEventListener("submit", submitOpenFolder);
elements["open-folder-form"].querySelectorAll('input[name="folder-mode"]').forEach((radio) => radio.addEventListener("change", updateFolderMode));
elements["cancel-open-folder"].addEventListener("click", () => elements["open-folder-dialog"].close());
elements["make-working-copy"].addEventListener("click", () => {
  if (!state.dataset) return;
  void openFolderPath(state.dataset.root, { preferCopy: true }).catch((error) => toast(error.message, "error"));
});
elements["open-trash"].addEventListener("click", async () => {
  if (!state.dataset) return toast("Choose a dataset first.", "error");
  try {
    await renderTrashList();
    elements["trash-dialog"].showModal();
  } catch (error) {
    toast(error.message, "error");
  }
});
elements["close-trash"].addEventListener("click", () => elements["trash-dialog"].close());
elements["empty-trash"].addEventListener("click", async () => {
  const sure = await showConfirm({
    title: "Empty the trash?",
    message: "Every deleted image and label of this dataset is removed from disk for good.",
    confirmLabel: "Empty trash",
    cancelLabel: "Keep them",
  });
  if (!sure) return;
  try {
    const { emptied } = await api(`/api/trash?dataset_id=${encodeURIComponent(state.dataset.id)}`, { method: "DELETE", body: "{}" });
    toast(`Removed ${formatCount(emptied)} deleted ${emptied === 1 ? "image" : "images"} for good.`);
    await renderTrashList();
  } catch (error) {
    toast(error.message, "error");
  }
});
elements["go-home"].addEventListener("click", () => {
  if (elements["editor-dialog"].open) return;
  clearTimeout(state.refreshTimer);
  showWelcome();
  void loadDatasets().catch(() => {});
});
elements["path-disclosure"].addEventListener("click", () => {
  const expanded = elements["path-disclosure"].getAttribute("aria-expanded") === "true";
  elements["path-disclosure"].setAttribute("aria-expanded", String(!expanded));
  elements["path-panel"].hidden = expanded;
});
elements["open-folder"].addEventListener("click", async () => {
  try {
    await openFolderPath(elements["folder-path"].value);
  } catch (error) {
    toast(error.message, "error");
  }
});
let searchTimer;
elements["search-input"].addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = event.target.value.trim();
    state.page = 1;
    void loadItems();
  }, 250);
});
elements["page-size"].addEventListener("change", (event) => {
  state.pageSize = Number(event.target.value);
  state.page = 1;
  void loadItems();
});
elements["previous-page"].addEventListener("click", () => { state.page -= 1; void loadItems(); });
elements["next-page"].addEventListener("click", () => { state.page += 1; void loadItems(); });
elements["first-page"].addEventListener("click", () => goToPage(1));
elements["last-page"].addEventListener("click", () => goToPage(state.pages));
elements["go-page"].addEventListener("change", (event) => goToPage(event.target.value));
elements["go-page"].addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    goToPage(event.currentTarget.value);
  }
});
const SINGLE_CLASS_HINT = "Save every box as one signature class";

/** When the signature check fails only because of class names, offer to export everything as one "signature" class. */
async function offerSingleClass(error, checkbox) {
  if (checkbox.checked || !String(error.message).includes(SINGLE_CLASS_HINT)) return false;
  const names = state.dataset?.class_names?.map((name) => `"${name}"`).join(", ") || "its classes";
  const accept = await showConfirm({
    title: "Export every box as one signature class?",
    message: `This dataset's data.yaml lists ${names}, and none of them is named "signature", so the signature check stops the export.`,
    confirmLabel: "Use one signature class",
    cancelLabel: "Cancel",
    tone: "warn",
    note: "Only the exported copy is changed: every box is written as class 0 and data.yaml lists one class, signature. Your dataset itself stays as it is.",
  });
  if (accept) checkbox.checked = true;
  return accept;
}

elements["export-dataset"].addEventListener("click", async function exportClicked() {
  if (!state.dataset) return toast("Select a dataset first.", "error");
  try {
    prepareExportDialog();
    elements["export-progress-title"].textContent = "Exporting dataset…";
    elements["export-progress"].value = 0;
    elements["export-progress-detail"].textContent = "Preparing image-label pairs";
    elements["export-progress-dialog"].showModal();
    const payload = await api(`/api/datasets/${state.dataset.id}/export`, {
      method: "POST",
      body: JSON.stringify({ folder_name: elements["export-name"].value, single_class: elements["export-single-class"].checked }),
    });
    elements["job-status"].textContent = "Export started in the background…";
    pollJob(payload.job.id);
  } catch (error) {
    if (elements["export-progress-dialog"].open) elements["export-progress-dialog"].close();
    if (await offerSingleClass(error, elements["export-single-class"])) return exportClicked();
    toast(error.message, "error");
  }
});
async function checkHubConnection(targetId) {
  const target = elements[targetId];
  target.dataset.state = "checking";
  target.textContent = "Checking the connection to Hugging Face…";
  try {
    const [server, browserReachable] = await Promise.all([
      api("/api/huggingface/status"),
      fetch("https://huggingface.co/api/datasets?limit=1", { signal: AbortSignal.timeout(8000) }).then((response) => response.ok).catch(() => false),
    ]);
    if (server.reachable && server.hub_ok === false) {
      target.dataset.state = "error";
      target.textContent = `Hugging Face answered with error ${server.status}. The Hub may be having problems; try again in a few minutes.`;
      return false;
    }
    if (server.reachable) {
      target.dataset.state = "ok";
      target.textContent = `Hugging Face is reachable (${formatCount(server.ms)} ms).`;
      return true;
    }
    target.dataset.state = "error";
    const browserNote = browserReachable && /huggingface\.co/.test(server.hub_url)
      ? " Your browser can reach Hugging Face, so only Node.js (the dashboard server) is blocked, which usually means a proxy or a company HTTPS certificate."
      : "";
    target.textContent = `${server.error?.message || "Hugging Face could not be reached."}${browserNote} (Node.js ${server.node_version})`;
    return false;
  } catch (error) {
    target.dataset.state = "error";
    target.textContent = error.message;
    return false;
  }
}

elements["hf-export-check"].addEventListener("click", () => void checkHubConnection("hf-export-connection"));
elements["hf-import-check"].addEventListener("click", () => void checkHubConnection("hf-import-connection"));
elements["cancel-publish"].addEventListener("click", async () => {
  const jobId = elements["cancel-publish"].dataset.jobId;
  if (!jobId) return;
  elements["cancel-publish"].disabled = true;
  try {
    await api(`/api/jobs/${jobId}/cancel`, { method: "POST", body: "{}" });
  } catch (error) {
    toast(error.message, "error");
    elements["cancel-publish"].disabled = false;
  }
});
elements["close-publish"].addEventListener("click", () => elements["export-progress-dialog"].close());

elements["open-hf-export"].addEventListener("click", () => {
  if (!state.dataset) return toast("Select a dataset first.", "error");
  elements["hf-export-zip-name"].value ||= `${suggestedExportName(state.dataset)}.zip`;
  elements["hf-export-error"].hidden = true;
  elements["hf-export-dialog"].showModal();
  void checkHubConnection("hf-export-connection");
  elements["hf-export-repo"].focus();
});
elements["cancel-hf-export"].addEventListener("click", () => {
  elements["hf-export-token"].value = "";
  elements["hf-export-dialog"].close();
});
elements["hf-export-dialog"].addEventListener("close", () => { elements["hf-export-token"].value = ""; });
elements["hf-export-form"].addEventListener("submit", async function publishSubmitted(event) {
  event?.preventDefault();
  if (!state.dataset) return;
  elements["start-hf-export"].disabled = true;
  elements["start-hf-export"].textContent = "Checking token and repository…";
  elements["hf-export-error"].hidden = true;
  let retrying = false;
  try {
    const payload = await api(`/api/datasets/${state.dataset.id}/huggingface-export`, {
      method: "POST",
      body: JSON.stringify({
        repo_id: elements["hf-export-repo"].value,
        zip_name: elements["hf-export-zip-name"].value,
        token: elements["hf-export-token"].value,
        create_if_missing: elements["hf-create-repo"].checked,
        private_repo: elements["hf-private-repo"].checked,
        single_class: elements["hf-single-class"].checked,
      }),
    });
    elements["hf-export-dialog"].close();
    preparePublishDialog();
    renderPublishProgress(payload.job);
    elements["export-progress-dialog"].showModal();
    pollJob(payload.job.id);
    elements["hf-export-token"].value = "";
  } catch (error) {
    if (await offerSingleClass(error, elements["hf-single-class"])) {
      retrying = true;
      elements["start-hf-export"].disabled = false;
      return publishSubmitted();
    }
    // Keep the dialog open and show what is wrong right where the user typed it.
    elements["hf-export-error"].textContent = error.message;
    elements["hf-export-error"].hidden = false;
  } finally {
    if (!retrying) {
      elements["start-hf-export"].disabled = false;
      elements["start-hf-export"].textContent = "Check and publish";
    }
  }
});

elements["select-tool"].addEventListener("click", () => setTool("select"));
elements["draw-tool"].addEventListener("click", () => setTool("draw"));
elements["add-box"].addEventListener("click", addCenteredBox);
elements["delete-box"].addEventListener("click", deleteSelectedBox);
elements["save-labels"].addEventListener("click", saveLabels);
elements["editor-previous"].addEventListener("click", () => navigateEditor(-1));
elements["editor-next"].addEventListener("click", () => navigateEditor(1));
elements["undo-action"].addEventListener("click", undoBoxes);
elements["rotate-left"].addEventListener("click", () => setOrientation(state.orientation - 90));
elements["rotate-right"].addEventListener("click", () => setOrientation(state.orientation + 90));
elements["delete-image"].addEventListener("click", deleteCurrentImage);
document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", requestEditorClose));
for (const id of ["box-class", "box-x", "box-y", "box-width", "box-height"]) elements[id].addEventListener("change", updateSelectedBoxFromFields);
elements["annotation-canvas"].addEventListener("pointerdown", onPointerDown);
elements["annotation-canvas"].addEventListener("pointermove", onPointerMove);
elements["annotation-canvas"].addEventListener("pointerup", onPointerUp);
elements["annotation-canvas"].addEventListener("pointercancel", onPointerUp);
elements["annotation-canvas"].addEventListener("keydown", (event) => {
  if (["Delete", "Backspace"].includes(event.key) && !event.shiftKey) {
    event.preventDefault();
    deleteSelectedBox();
  }
});
elements["editor-dialog"].addEventListener("close", () => {
  state.imageRequestToken += 1;
  state.editorLoading = false;
  state.undoStack = [];
  state.orientation = 0;
  state.image = null;
  state.currentItem = null;
  state.pointerAction = null;
});
elements["rename-dataset"].addEventListener("click", openRenameDialog);
elements["rename-form"].addEventListener("submit", renameActiveDataset);
elements["cancel-rename"].addEventListener("click", () => elements["rename-dialog"].close());
elements["editor-dialog"].addEventListener("cancel", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  void requestEditorClose();
});
window.addEventListener("resize", () => { if (state.image) drawCanvas(); });
window.addEventListener("keydown", (event) => {
  const tag = document.activeElement?.tagName;
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
  if (document.querySelector("dialog[open]:not(#editor-dialog)")) return;
  if (elements["editor-dialog"].open) {
    if (event.key === "Delete" && event.shiftKey) {
      event.preventDefault();
      void deleteCurrentImage();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoBoxes();
      return;
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && ["v", "b"].includes(event.key.toLowerCase())) {
      setTool(event.key.toLowerCase() === "v" ? "select" : "draw");
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      void navigateEditor(-1);
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      void navigateEditor(1);
    }
    return;
  }
  if (event.key === "ArrowLeft" && state.page > 1) {
    event.preventDefault();
    state.page -= 1;
    void loadItems();
  }
  if (event.key === "ArrowRight" && state.page < state.pages) {
    event.preventDefault();
    state.page += 1;
    void loadItems();
  }
});

// Keep toasts and the activity card above whichever dialog is open, and bring them back when it closes.
new MutationObserver(() => {
  raiseToTop(elements["toast-region"]);
  raiseToTop(elements["upload-panel"]);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });

try {
  void purgeExpiredTrash();
  await loadDatasets();
  showWelcome();
} catch (error) {
  toast(error.message, "error");
}
