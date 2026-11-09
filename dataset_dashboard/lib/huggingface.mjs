import path from "node:path";
import { IMAGE_EXTENSIONS, canonicalSplit } from "./dataset.mjs";

const HUB_HOSTS = new Set(["huggingface.co", "www.huggingface.co", "hf.co"]);
const REPO_PART = /^[A-Za-z0-9][\w.-]*$/;
const REVISION_PATTERN = /^[A-Za-z0-9._/-]+$/;

export function hubError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function isSafeRepoPath(value) {
  const normalized = String(value || "").trim().replaceAll("\\", "/");
  if (!normalized) return true;
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((part) => part === ".." || part === ".");
}

export function normalizeRevision(value) {
  const revision = String(value || "main").trim() || "main";
  if (revision.includes("..") || !REVISION_PATTERN.test(revision)) throw hubError("Invalid Hugging Face revision.");
  return revision;
}

/**
 * Accepts every common way of pointing at a dataset repository:
 *   user/repo · datasets/user/repo · https://huggingface.co/datasets/user/repo
 *   .../tree/<revision>/<folder> · .../blob/<revision>/<file.zip> · .../resolve/<revision>/<file.zip>
 */
export function parseHubReference(input, fallbackRevision = "main") {
  let text = String(input || "").trim();
  if (!text) throw hubError("Enter a Hugging Face dataset repository, for example username/signatures.");
  let revision = null;
  let repoPath = "";

  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw hubError("That Hugging Face link is not a valid URL.");
    }
    if (!HUB_HOSTS.has(url.hostname.toLowerCase())) throw hubError("Only huggingface.co dataset links are supported.");
    text = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
    if (!text.startsWith("datasets/")) throw hubError("This link is not a dataset repository. Dataset links start with huggingface.co/datasets/.");
  }

  const parts = text.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts[0] === "datasets") parts.shift();
  if (parts.length < 2) throw hubError("Use a dataset repository ID such as username/signatures.");
  const [owner, name, mode, ...rest] = parts;
  if (!REPO_PART.test(owner) || !REPO_PART.test(name)) throw hubError("Use a dataset repository ID such as username/signatures.");
  if (mode && ["tree", "blob", "resolve"].includes(mode) && rest.length) {
    revision = rest.shift();
    repoPath = rest.join("/");
  } else if (mode) {
    throw hubError("Unrecognized Hugging Face dataset link. Paste the repository page, a folder (tree) link or a file link.");
  }
  if (!isSafeRepoPath(repoPath)) throw hubError("The repository path is not safe.");
  return {
    repoId: `${owner}/${name}`,
    revision: normalizeRevision(revision || fallbackRevision),
    path: repoPath,
  };
}

function lowerParts(filePath) {
  return filePath.split("/").filter(Boolean);
}

/** Folder that acts as the dataset root for a YOLO image/label file, or null. */
export function yoloRootOf(filePath) {
  const parts = lowerParts(filePath);
  const lower = parts.map((part) => part.toLowerCase());
  const imagesIndex = lower.findIndex((part, index) => (part === "images" || part === "labels") && index < parts.length - 1);
  if (imagesIndex < 0) return null;
  const before = imagesIndex > 0 ? canonicalSplit(lower[imagesIndex - 1]) : null;
  const after = imagesIndex + 1 < parts.length - 1 ? canonicalSplit(lower[imagesIndex + 1]) : null;
  let rootEnd = imagesIndex;
  let split = after || "all";
  if (before) {
    rootEnd = imagesIndex - 1;
    split = before;
  }
  return { root: parts.slice(0, rootEnd).join("/"), split, kind: lower[imagesIndex] === "labels" ? "label" : "image" };
}

function isImage(filePath) {
  return IMAGE_EXTENSIONS.has(path.posix.extname(filePath).toLowerCase());
}

function isYaml(filePath) {
  return ["data.yaml", "data.yml"].includes(path.posix.basename(filePath).toLowerCase());
}

export function analyzeHubFiles(entries) {
  const files = entries.filter((entry) => entry.type === "file");
  const zips = [];
  const roots = new Map();
  let parquetFiles = 0;
  let totalBytes = 0;

  const rootFor = (root) => {
    if (!roots.has(root)) roots.set(root, { path: root, images: 0, labels: 0, bytes: 0, splits: new Set(), has_yaml: false });
    return roots.get(root);
  };

  for (const file of files) {
    const size = Number(file.lfs?.size ?? file.size) || 0;
    totalBytes += size;
    const extension = path.posix.extname(file.path).toLowerCase();
    if (extension === ".zip") zips.push({ path: file.path, size });
    if (extension === ".parquet") parquetFiles += 1;
    if (isImage(file.path) || (extension === ".txt" && /(^|\/)labels\//i.test(file.path))) {
      const located = yoloRootOf(file.path);
      if (!located) continue;
      const root = rootFor(located.root);
      root.bytes += size;
      if (located.kind === "image" && isImage(file.path)) {
        root.images += 1;
        root.splits.add(located.split);
      } else if (located.kind === "label" && extension === ".txt") {
        root.labels += 1;
      }
    }
  }

  for (const file of files) {
    if (!isYaml(file.path)) continue;
    const parent = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
    if (roots.has(parent)) roots.get(parent).has_yaml = true;
  }

  const folders = [...roots.values()]
    .filter((root) => root.images > 0)
    .map((root) => ({ ...root, splits: [...root.splits].sort() }))
    .sort((left, right) => right.images - left.images);
  zips.sort((left, right) => right.size - left.size);

  let recommended = null;
  if (zips.length === 1 && !folders.some((folder) => folder.labels > 0)) recommended = { mode: "zip", path: zips[0].path };
  else if (folders.some((folder) => folder.labels > 0)) {
    const best = folders.find((folder) => folder.labels > 0);
    recommended = zips.length ? { mode: "zip", path: zips[0].path } : { mode: "folder", path: best.path };
  } else if (zips.length) recommended = { mode: "zip", path: zips[0].path };

  const notes = [];
  if (!zips.length && !folders.length && parquetFiles) {
    notes.push("This repository stores data as Parquet files. Only ZIP archives and YOLO image/label folders can be imported; export it as a YOLO ZIP first.");
  } else if (!zips.length && !folders.length) {
    notes.push("No ZIP archive or YOLO images/labels folder was found in this repository.");
  }
  for (const folder of folders) {
    if (folder.labels === 0) notes.push(`${folder.path || "Repository root"} has images but no YOLO labels folder.`);
  }

  return {
    total_files: files.length,
    total_bytes: totalBytes,
    zips,
    folders,
    parquet_files: parquetFiles,
    recommended,
    notes,
  };
}

/** Files to download for a YOLO folder import, ordered so labels land before their images. */
export function selectFolderFiles(entries, rootPath) {
  const prefix = rootPath ? `${rootPath.replace(/\/+$/, "")}/` : "";
  const selected = [];
  for (const entry of entries) {
    if (entry.type !== "file") continue;
    if (prefix && !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (!relative || !isSafeRepoPath(relative)) continue;
    const extension = path.posix.extname(relative).toLowerCase();
    const located = yoloRootOf(entry.path);
    const insideRoot = located && located.root === (rootPath || "").replace(/\/+$/, "");
    const yamlAtRoot = isYaml(relative) && !relative.includes("/");
    const wanted = yamlAtRoot
      || (insideRoot && located.kind === "image" && IMAGE_EXTENSIONS.has(extension))
      || (insideRoot && located.kind === "label" && extension === ".txt");
    if (!wanted) continue;
    const rank = yamlAtRoot ? 0 : extension === ".txt" ? 1 : 2;
    selected.push({ path: entry.path, relative, size: Number(entry.lfs?.size ?? entry.size) || 0, rank });
  }
  return selected.sort((left, right) => left.rank - right.rank || left.relative.localeCompare(right.relative));
}

export function hubFileUrl(hubUrl, repoId, revision, filePath) {
  const encodedRepo = repoId.split("/").map(encodeURIComponent).join("/");
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `${hubUrl.replace(/\/+$/, "")}/datasets/${encodedRepo}/resolve/${encodeURIComponent(revision || "main")}/${encodedPath}`;
}

export function friendlyHubError(error, { repoId = "", revision = "main" } = {}) {
  const status = Number(error?.statusCode || error?.status || 0);
  const raw = error instanceof Error ? error.message : String(error);
  if (status === 401) return hubError(`“${repoId}” is private or gated. Add an access token with read permission.`, 401);
  if (status === 403) return hubError(`Access to “${repoId}” was refused. If it is gated, accept its terms on huggingface.co with the same account as your token.`, 403);
  if (status === 404) return hubError(`Dataset “${repoId}” or revision “${revision}” was not found. Check the spelling, or add a token if it is private.`, 404);
  const network = describeNetworkError(error);
  if (network) return Object.assign(hubError(networkErrorMessage(network), 502), { network });
  return hubError(raw, status >= 400 && status < 600 ? status : 400);
}

const CERTIFICATE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function causeChain(error) {
  const chain = [];
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * Explains why Node.js could not reach the Hub ("fetch failed" hides the real reason in error.cause).
 * Returns null when the error is not a network problem.
 */
export function describeNetworkError(error, env = process.env) {
  const chain = causeChain(error);
  const code = chain.map((entry) => entry?.code).find(Boolean) || "";
  const text = chain.map((entry) => entry?.message || "").join(" ");
  if (!code && !/fetch failed|network|socket|terminated|timed? ?out/i.test(text)) return null;
  const proxySet = Boolean(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
  let reason = "the connection failed";
  let hint = "Check that this computer can open https://huggingface.co, then try again.";
  if (CERTIFICATE_CODES.has(code) || /certificate/i.test(text)) {
    reason = "the HTTPS certificate was not trusted";
    hint = "A company network or antivirus is probably inspecting HTTPS. Start the dashboard with the system certificates: set NODE_OPTIONS=--use-system-ca (Node.js 22.15 or newer), or set NODE_EXTRA_CA_CERTS to your company's root certificate file.";
  } else if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
    reason = "the name huggingface.co could not be resolved (DNS)";
    hint = "Check your internet connection or DNS settings.";
  } else if (["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(code) || /timed? ?out/i.test(text)) {
    reason = "the connection timed out";
    hint = proxySet
      ? "A proxy is configured. Node.js only uses it when NODE_USE_ENV_PROXY=1 is set (Node.js 22.21 or 24 and newer)."
      : "A firewall or proxy may be blocking Node.js. If your browser uses a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 before starting the dashboard.";
  } else if (["ECONNREFUSED", "ECONNRESET", "UND_ERR_SOCKET", "EPIPE"].includes(code)) {
    reason = "the connection was refused or reset";
    hint = "A firewall, VPN or proxy is likely blocking Node.js. If your browser uses a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1 before starting the dashboard.";
  }
  return { code: code || "FETCH_FAILED", reason, hint, proxy_configured: proxySet };
}

export function networkErrorMessage(details) {
  return `Hugging Face could not be reached: ${details.reason} (${details.code}). ${details.hint}`;
}
