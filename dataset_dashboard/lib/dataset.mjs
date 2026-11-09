import { createHash } from "node:crypto";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"]);

const SPLIT_ALIASES = new Map([
  ["train", "train"],
  ["training", "train"],
  ["test", "test"],
  ["testing", "test"],
  ["val", "valid"],
  ["valid", "valid"],
  ["validation", "valid"],
]);

export function stableId(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

export function canonicalSplit(value) {
  return SPLIT_ALIASES.get(String(value).toLowerCase()) ?? null;
}

export function itemMatchesView(item, view) {
  if (view === "unlabeled") return item.hasLabel === false;
  if (view === "issues") return Boolean(item.labelIssues?.length);
  return item.split === view;
}

export function normalizeForComparison(value) {
  return path.resolve(value).replaceAll("\\", "/").toLowerCase();
}

export function isPathInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function describeImagePath(imagePath, datasetRoot) {
  const absolute = path.resolve(imagePath);
  const relative = path.relative(path.resolve(datasetRoot), absolute);
  const parts = relative.split(path.sep);
  const lower = parts.map((part) => part.toLowerCase());
  const imagesIndex = lower.lastIndexOf("images");

  let splitIndex = -1;
  let split = null;
  let layout = null;

  if (imagesIndex >= 0 && imagesIndex + 1 < parts.length) {
    const candidate = canonicalSplit(parts[imagesIndex + 1]);
    if (candidate) {
      split = candidate;
      splitIndex = imagesIndex + 1;
      layout = "images-first";
    }
  }

  if (!split && imagesIndex > 0) {
    const candidate = canonicalSplit(parts[imagesIndex - 1]);
    if (candidate) {
      split = candidate;
      splitIndex = imagesIndex - 1;
      layout = "split-first";
    }
  }

  if (!split) {
    splitIndex = lower.findIndex((part) => canonicalSplit(part));
    if (splitIndex >= 0) {
      split = canonicalSplit(parts[splitIndex]);
      layout = imagesIndex >= 0 && imagesIndex < splitIndex ? "images-first" : "split-first";
    }
  }

  if (imagesIndex < 0) {
    const fileRelativeParts = splitIndex >= 0 ? parts.slice(splitIndex + 1) : parts;
    if (!fileRelativeParts.length) return null;
    return {
      split: split || "all",
      layout: "loose-images",
      relative,
      relativeWithinSplit: fileRelativeParts.join("/"),
      labelPath: path.join(path.dirname(absolute), `${path.parse(absolute).name}.txt`),
    };
  }

  if (!split) {
    const fileRelativeParts = parts.slice(imagesIndex + 1);
    if (!fileRelativeParts.length) return null;
    const labelParts = [...parts];
    labelParts[imagesIndex] = "labels";
    labelParts[labelParts.length - 1] = `${path.parse(labelParts.at(-1)).name}.txt`;
    return {
      split: "all",
      layout: "unsplit",
      relative,
      relativeWithinSplit: fileRelativeParts.join("/"),
      labelPath: path.join(datasetRoot, ...labelParts),
    };
  }

  const fileRelativeParts = parts.slice(Math.max(imagesIndex, splitIndex) + 1);
  if (!fileRelativeParts.length) return null;

  const labelParts = [...parts];
  labelParts[imagesIndex] = "labels";
  labelParts[labelParts.length - 1] = `${path.parse(labelParts.at(-1)).name}.txt`;

  return {
    split,
    layout,
    relative,
    relativeWithinSplit: fileRelativeParts.join("/"),
    labelPath: path.join(datasetRoot, ...labelParts),
  };
}

export function parseYolo(text) {
  const boxes = [];
  const errors = [];
  const warnings = [];
  let converted = 0;
  const lines = String(text ?? "").split(/\r?\n/);

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/\s+/);
    const values = parts.map(Number);
    const classId = values[0];
    if (!values.every(Number.isFinite) || !Number.isInteger(classId) || classId < 0) {
      errors.push(`Line ${index + 1}: values are not a valid YOLO row.`);
      return;
    }
    if (parts.length > 5 && parts.length % 2 === 1) {
      const coordinates = values.slice(1);
      if (coordinates.length < 6 || coordinates.some((value) => value < 0 || value > 1)) {
        errors.push(`Line ${index + 1}: polygon coordinates must contain at least 3 normalized points.`);
        return;
      }
      const xs = coordinates.filter((_value, coordinateIndex) => coordinateIndex % 2 === 0);
      const ys = coordinates.filter((_value, coordinateIndex) => coordinateIndex % 2 === 1);
      const left = Math.min(...xs);
      const right = Math.max(...xs);
      const top = Math.min(...ys);
      const bottom = Math.max(...ys);
      if (right <= left || bottom <= top) {
        errors.push(`Line ${index + 1}: polygon has no usable area.`);
        return;
      }
      boxes.push({
        class_id: classId,
        x_center: (left + right) / 2,
        y_center: (top + bottom) / 2,
        width: right - left,
        height: bottom - top,
      });
      converted += 1;
      warnings.push(`Line ${index + 1}: segmentation polygon is displayed as its bounding box; saving converts it to detection format.`);
      return;
    }
    if (parts.length !== 5) {
      errors.push(`Line ${index + 1}: expected 5 detection values or a valid polygon row, found ${parts.length}.`);
      return;
    }
    const [, xCenter, yCenter, width, height] = values;
    if ([xCenter, yCenter, width, height].some((value) => value < 0 || value > 1) || width <= 0 || height <= 0) {
      errors.push(`Line ${index + 1}: normalized coordinates must be inside 0..1 and size must be positive.`);
      return;
    }
    boxes.push({ class_id: classId, x_center: xCenter, y_center: yCenter, width, height });
  });

  return { boxes, errors, warnings, converted };
}

function formatNumber(value) {
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function serializeYolo(boxes) {
  return boxes
    .map((box, index) => {
      const classId = Number(box.class_id);
      const values = [box.x_center, box.y_center, box.width, box.height].map(Number);
      if (!Number.isInteger(classId) || classId < 0 || !values.every(Number.isFinite)) {
        throw new Error(`Box ${index + 1} contains invalid values.`);
      }
      const [xCenter, yCenter, width, height] = values;
      if ([xCenter, yCenter, width, height].some((value) => value < 0 || value > 1) || width <= 0 || height <= 0) {
        throw new Error(`Box ${index + 1} must stay within the image and have positive width/height.`);
      }
      return [classId, ...values.map(formatNumber)].join(" ");
    })
    .join("\n") + (boxes.length ? "\n" : "");
}

export function parseClassNames(yamlText) {
  const text = String(yamlText ?? "");
  const lines = text.split(/\r?\n/);
  const names = [];
  let inNames = false;
  let namesIndent = 0;

  for (const line of lines) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const trimmed = line.trim();
    if (!inNames) {
      const inline = trimmed.match(/^names\s*:\s*\[(.*)]\s*$/i);
      if (inline) {
        return inline[1].split(",").map((name) => name.trim().replace(/^['"]|['"]$/g, ""));
      }
      if (/^names\s*:\s*$/i.test(trimmed)) {
        inNames = true;
        namesIndent = indent;
      }
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;
    if (indent <= namesIndent && !trimmed.startsWith("-")) break;
    const listMatch = trimmed.match(/^-\s*(.+)$/);
    const mapMatch = trimmed.match(/^(\d+)\s*:\s*(.+)$/);
    if (listMatch) names.push(listMatch[1].trim().replace(/^['"]|['"]$/g, ""));
    if (mapMatch) names[Number(mapMatch[1])] = mapMatch[2].trim().replace(/^['"]|['"]$/g, "");
  }

  return names.filter((name) => name !== undefined);
}

export async function* walkFiles(root) {
  const directories = [path.resolve(root)];
  while (directories.length) {
    const current = directories.pop();
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) directories.push(fullPath);
      else if (entry.isFile()) yield fullPath;
    }
  }
}

export async function discoverYamlRoots(root) {
  const roots = [];
  const directories = [path.resolve(root)];
  while (directories.length) {
    const current = directories.pop();
    let directory;
    try {
      directory = await opendir(current);
    } catch {
      continue;
    }
    for await (const entry of directory) {
      if (entry.isDirectory()) {
        // A dataset config never belongs inside a directory full of image/label files.
        // Pruning these branches keeps startup fast even with hundreds of thousands of files.
        if (!["images", "labels"].includes(entry.name.toLowerCase())) directories.push(path.join(current, entry.name));
      } else if (entry.isFile() && ["data.yaml", "data.yml"].includes(entry.name.toLowerCase())) {
        roots.push(current);
      }
    }
  }
  return roots;
}

export async function loadClassNames(root) {
  for (const filename of ["data.yaml", "data.yml"]) {
    try {
      return parseClassNames(await readFile(path.join(root, filename), "utf8"));
    } catch {
      // Try the next conventional filename.
    }
  }
  return ["signature"];
}

export async function inspectFile(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/**
 * Returns data.yaml text with its class list replaced by `names` (and nc updated),
 * keeping every other key (train/val/test paths, roboflow metadata, …) unchanged.
 */
export function replaceClassNames(yamlText, names) {
  const block = ["names:", ...names.map((name) => `  - ${JSON.stringify(String(name))}`)];
  const ncLine = `nc: ${names.length}`;
  const lines = String(yamlText ?? "").replace(/\r\n/g, "\n").split("\n");
  if (lines.length && lines.at(-1) === "") lines.pop();
  const output = [];
  let replaced = false;
  let ncWritten = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^\s*/)[0].length;
    const trimmed = line.trim();
    if (indent === 0 && /^nc\s*:/.test(trimmed)) {
      output.push(ncLine);
      ncWritten = true;
      continue;
    }
    if (indent === 0 && /^names\s*:/.test(trimmed)) {
      replaced = true;
      output.push(...block);
      if (/^names\s*:\s*\S/.test(trimmed)) continue; // inline list or map on one line
      while (index + 1 < lines.length) {
        const next = lines[index + 1];
        const nextIndent = next.match(/^\s*/)[0].length;
        const nextTrimmed = next.trim();
        if (nextTrimmed && nextIndent === 0 && !nextTrimmed.startsWith("-")) break;
        if (!nextTrimmed && index + 2 < lines.length && lines[index + 2].match(/^\s*/)[0].length === 0 && !lines[index + 2].trim().startsWith("-")) break;
        index += 1;
      }
      continue;
    }
    output.push(line);
  }
  if (!replaced) output.push(...block);
  if (!ncWritten) output.push(ncLine);
  return `${output.join("\n")}\n`;
}
