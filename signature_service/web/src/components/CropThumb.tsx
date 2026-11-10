interface Props {
  src: string;
  box: [number, number, number, number];
  imageSize: { width: number; height: number };
  maxW?: number;
  maxH?: number;
  alt: string;
}

/** A zoomed view of one detected region, cut from the original image with CSS (no re-upload). */
export function CropThumb({ src, box, imageSize, maxW = 132, maxH = 64, alt }: Props) {
  const [x1, y1, x2, y2] = box;
  const bw = Math.max(1, x2 - x1);
  const bh = Math.max(1, y2 - y1);
  const scale = Math.min(maxW / bw, maxH / bh);
  return (
    <div
      role="img"
      aria-label={alt}
      className="shrink-0 rounded-md border border-desk-line bg-paper bg-no-repeat"
      style={{
        width: Math.round(bw * scale),
        height: Math.round(bh * scale),
        backgroundImage: `url("${src}")`,
        backgroundSize: `${imageSize.width * scale}px ${imageSize.height * scale}px`,
        backgroundPosition: `${-x1 * scale}px ${-y1 * scale}px`,
      }}
    />
  );
}
