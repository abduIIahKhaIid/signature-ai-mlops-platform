export function isSignatureClassName(name) {
  return String(name).trim().toLowerCase().includes("signature");
}

/**
 * Decides whether a dataset is usable for signature detection.
 * - singleClass: every box will be written as class 0 "signature" (export option), so class names do not matter.
 * - strictClasses: class-name problems are errors (exports) instead of warnings (imports).
 */
export function assessSignatureDataset({
  imageCount = 0,
  labelFileCount = 0,
  validLabelFileCount = 0,
  boxCount = 0,
  signatureBoxCount = 0,
  classNames = [],
  hasExplicitClassConfig = false,
  singleClass = false,
  strictClasses = true,
} = {}) {
  const errors = [];
  const warnings = [];
  const hasSignatureClass = classNames.some(isSignatureClassName);
  const listedNames = classNames.map((name) => `"${name}"`).join(", ");

  if (imageCount < 1) errors.push("No supported images were found.");
  if (labelFileCount < 1) errors.push("No matching YOLO/Roboflow .txt label files were found.");
  if (validLabelFileCount < 1) errors.push("No readable label file with a valid annotation was found.");
  if (boxCount < 1) errors.push("The dataset does not contain any valid bounding boxes.");

  const classProblems = [];
  if (!singleClass && hasExplicitClassConfig && !hasSignatureClass) {
    classProblems.push(`data.yaml lists the classes ${listedNames || "(none)"}, but none is named "signature". Turn on "Save every box as one signature class" to export it as a single signature class.`);
  }
  if (!singleClass && hasExplicitClassConfig && hasSignatureClass && signatureBoxCount < 1) {
    classProblems.push(`No bounding box uses the signature class ID. Turn on "Save every box as one signature class" if all boxes are signatures.`);
  }
  if (strictClasses) errors.push(...classProblems);
  else warnings.push(...classProblems);

  if (!singleClass && !hasExplicitClassConfig) warnings.push("No data.yaml class declaration was found; class 0 is treated as signature.");
  if (imageCount > labelFileCount) warnings.push(`${imageCount - labelFileCount} image(s) do not have a matching label file.`);

  return {
    valid: errors.length === 0,
    kind: "signature-object-detection",
    image_count: imageCount,
    label_file_count: labelFileCount,
    valid_label_file_count: validLabelFileCount,
    box_count: boxCount,
    signature_box_count: singleClass || !hasExplicitClassConfig ? boxCount : signatureBoxCount,
    signature_class: singleClass || hasSignatureClass || !hasExplicitClassConfig,
    needs_single_class: hasExplicitClassConfig && (!hasSignatureClass || signatureBoxCount < 1),
    errors,
    warnings,
  };
}

export const LABEL_ISSUE_TEXT = {
  "invalid-rows": "Invalid rows",
  polygon: "Polygon rows",
  "unknown-class": "Unknown class",
  "other-class": "Non-signature class",
};

/**
 * Per-file label problems shown in the "Needs fixing" tab.
 * parsed is the result of parseYolo(); classNames comes from data.yaml.
 */
export function describeLabelIssues(parsed, classNames = []) {
  const issues = [];
  if (parsed.errors.length) issues.push({ code: "invalid-rows", count: parsed.errors.length });
  if (parsed.converted) issues.push({ code: "polygon", count: parsed.converted });
  if (classNames.length) {
    const unknown = parsed.boxes.filter((box) => box.class_id >= classNames.length).length;
    if (unknown) issues.push({ code: "unknown-class", count: unknown });
    const signatureIds = new Set(classNames.map((name, index) => (isSignatureClassName(name) ? index : -1)).filter((index) => index >= 0));
    if (signatureIds.size && classNames.length > 1) {
      const other = parsed.boxes.filter((box) => box.class_id < classNames.length && !signatureIds.has(box.class_id)).length;
      if (other) issues.push({ code: "other-class", count: other });
    }
  }
  return issues;
}
