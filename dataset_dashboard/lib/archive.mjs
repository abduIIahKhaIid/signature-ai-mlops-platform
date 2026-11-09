import path from "node:path";
import { IMAGE_EXTENSIONS } from "./dataset.mjs";

export function archiveParts(entry) {
  return String(entry || "").trim().replaceAll("\\", "/").split("/").filter(Boolean);
}

export function archiveRootCandidate(entry) {
  const parts = archiveParts(entry);
  if (!parts.length) return null;
  const lower = parts.map((part) => part.toLowerCase());
  const filename = lower.at(-1);
  if (["data.yaml", "data.yml"].includes(filename)) return { depth: parts.length - 1, priority: 3 };

  const splitNames = new Set(["train", "training", "test", "testing", "val", "valid", "validation"]);
  for (let index = 0; index < lower.length - 1; index += 1) {
    if (splitNames.has(lower[index]) && ["images", "labels"].includes(lower[index + 1])) return { depth: index, priority: 2 };
    if (["images", "labels"].includes(lower[index]) && splitNames.has(lower[index + 1])) return { depth: index, priority: 2 };
  }
  const mediaIndex = lower.findIndex((part) => ["images", "labels"].includes(part));
  return mediaIndex >= 0 ? { depth: mediaIndex, priority: 1 } : null;
}

export function assetDirectoryParts(entry) {
  const parts = archiveParts(entry);
  if (!parts.length) return null;
  const extension = path.extname(parts.at(-1)).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension) && extension !== ".txt") return null;
  return parts.slice(0, -1);
}

export function commonPrefix(left, right) {
  if (!left) return [...right];
  const result = [];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (left[index].toLowerCase() !== right[index].toLowerCase()) break;
    result.push(left[index]);
  }
  return result;
}
