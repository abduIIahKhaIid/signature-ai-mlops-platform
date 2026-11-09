import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IMAGE_EXTENSIONS,
  describeImagePath,
  discoverYamlRoots,
  parseYolo,
  walkFiles,
} from "../lib/dataset.mjs";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const datasetRoot = path.resolve(process.argv[2] || path.join(scriptRoot, "..", "..", "Dataset"));
const roots = await discoverYamlRoots(datasetRoot);
const reports = [];

for (const root of roots) {
  const images = [];
  for await (const filePath of walkFiles(root)) {
    if (!IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) continue;
    const description = describeImagePath(filePath, root);
    if (description) images.push({ filePath, ...description });
  }

  const report = {
    name: path.basename(root),
    root,
    images: images.length,
    splits: {},
    label_files: 0,
    missing_labels: 0,
    empty_labels: 0,
    invalid_label_files: 0,
    invalid_rows: 0,
    polygon_label_files: 0,
    polygon_rows_converted_to_boxes: 0,
    boxes: 0,
    classes: {},
    boxes_over_90_percent_area: 0,
  };
  for (const image of images) report.splits[image.split] = (report.splits[image.split] || 0) + 1;

  for (let start = 0; start < images.length; start += 64) {
    const chunk = images.slice(start, start + 64);
    await Promise.all(chunk.map(async (image) => {
      let text;
      try {
        text = await readFile(image.labelPath, "utf8");
        report.label_files += 1;
      } catch (error) {
        if (error.code === "ENOENT") {
          report.missing_labels += 1;
          return;
        }
        throw error;
      }
      if (!text.trim()) report.empty_labels += 1;
      const parsed = parseYolo(text);
      if (parsed.errors.length) {
        report.invalid_label_files += 1;
        report.invalid_rows += parsed.errors.length;
      }
      if (parsed.converted) {
        report.polygon_label_files += 1;
        report.polygon_rows_converted_to_boxes += parsed.converted;
      }
      report.boxes += parsed.boxes.length;
      for (const box of parsed.boxes) {
        report.classes[box.class_id] = (report.classes[box.class_id] || 0) + 1;
        if (box.width * box.height > 0.9) report.boxes_over_90_percent_area += 1;
      }
    }));
  }
  reports.push(report);
}

console.log(JSON.stringify({ dataset_root: datasetRoot, datasets: reports }, null, 2));
