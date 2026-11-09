export function createBoxSnapshot(boxes, selectedBox) {
  return {
    boxes: boxes.map((box) => ({ ...box })),
    selectedBox: Number(selectedBox),
  };
}

export function restoreBoxSnapshot(snapshot) {
  return {
    boxes: snapshot.boxes.map((box) => ({ ...box })),
    selectedBox: Math.min(snapshot.selectedBox, snapshot.boxes.length - 1),
  };
}
