import path from "node:path";

/**
 * Picks a collision-free file name for an export folder.
 * Images and labels share one stem (a.jpg -> a.txt), so stems are reserved
 * case-insensitively per folder: a.jpg + a.png, or two sub-datasets that both
 * contain train/images/a.jpg, can never overwrite each other's label or image.
 */
export function createExportNamer() {
  const used = new Map();
  return function reserve(folderKey, fileName) {
    const parsed = path.posix.parse(fileName);
    const folder = String(folderKey).toLowerCase();
    if (!used.has(folder)) used.set(folder, new Set());
    const stems = used.get(folder);
    let stem = parsed.name;
    let suffix = 1;
    while (stems.has(stem.toLowerCase())) {
      suffix += 1;
      stem = `${parsed.name}__${suffix}`;
    }
    stems.add(stem.toLowerCase());
    return { stem, fileName: `${stem}${parsed.ext}`, renamed: suffix > 1 };
  };
}
