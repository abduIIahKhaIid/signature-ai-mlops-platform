export function normalizeOrientation(value) {
  const normalized = ((Number(value) % 360) + 360) % 360;
  return [0, 90, 180, 270].includes(normalized) ? normalized : 0;
}

export function orientedSize(width, height, orientation) {
  const rotation = normalizeOrientation(orientation);
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

export function viewToSource(rotatedX, rotatedY, sourceWidth, sourceHeight, orientation) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value)));
  const rotation = normalizeOrientation(orientation);
  if (rotation === 90) return { x: clamp(rotatedY, 0, sourceWidth), y: clamp(sourceHeight - rotatedX, 0, sourceHeight) };
  if (rotation === 180) return { x: clamp(sourceWidth - rotatedX, 0, sourceWidth), y: clamp(sourceHeight - rotatedY, 0, sourceHeight) };
  if (rotation === 270) return { x: clamp(sourceWidth - rotatedY, 0, sourceWidth), y: clamp(rotatedX, 0, sourceHeight) };
  return { x: clamp(rotatedX, 0, sourceWidth), y: clamp(rotatedY, 0, sourceHeight) };
}
