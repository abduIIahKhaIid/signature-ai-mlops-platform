import { useState } from "react";
import type { Detection } from "../lib/api";

export interface SheetBox {
  key: string | number;
  detection: Detection;
  label: string;
}

interface Props {
  src: string;
  alt: string;
  /** Size of the image the server analysed (after EXIF rotation); box coordinates are in this space. */
  imageSize?: { width: number; height: number } | null;
  boxes: SheetBox[];
  active?: string | number | null;
  onActive?: (key: string | number | null) => void;
  scanning?: boolean;
  /** Changes whenever a new result arrives, so the boxes play their reveal again. */
  revealKey?: string | number;
  maxHeight?: string;
  onImageError?: () => void;
}


/** The document as a sheet of paper on the desk, with signature boxes drawn on top of it. */
export function DocumentSheet({ src, alt, imageSize, boxes, active, onActive, scanning, revealKey, maxHeight = "78vh", onImageError }: Props) {
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const size = imageSize ?? natural;

  return (
    <div className="relative mx-auto w-fit max-w-full bg-paper p-2.5 shadow-sheet sm:p-3.5">
      <div className="relative">
        <img
          src={src}
          alt={alt}
          onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={onImageError}
          className="block h-auto max-w-full select-none object-contain"
          style={{ maxHeight }}
          draggable={false}
        />
        {size &&
          boxes.map((b, i) => {
            const [x1, y1, x2, y2] = b.detection.box_xyxy;
            const unsure = b.detection.score < 0.5; // low confidence: dashed outline
            const isActive = active === b.key;
            const nearTop = y1 / size.height < 0.06;
            return (
              <div
                key={`${revealKey}-${b.key}`}
                className="absolute"
                style={{
                  left: `${(x1 / size.width) * 100}%`,
                  top: `${(y1 / size.height) * 100}%`,
                  width: `${((x2 - x1) / size.width) * 100}%`,
                  height: `${((y2 - y1) / size.height) * 100}%`,
                }}
                onMouseEnter={() => onActive?.(b.key)}
                onMouseLeave={() => onActive?.(null)}
              >
                <div
                  className={`sheet-box absolute inset-0 rounded-[3px] border-[2.5px] border-marker ${unsure ? "border-dashed" : ""} ${
                    isActive ? "bg-marker/10 ring-4 ring-marker/25" : ""
                  } transition-[background-color,box-shadow]`}
                  style={{ animationDelay: `${i * 90}ms` }}
                />
                {(boxes.length <= 8 || isActive) && <span
                  className={`absolute left-[-2.5px] z-10 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[12px] font-bold leading-none text-white tnum animate-tagin bg-marker ${
                    nearTop ? "top-full mt-1" : "bottom-full mb-1"
                  }`}
                  style={{ animationDelay: `${i * 90 + 350}ms` }}
                >
                  {b.label} {(b.detection.score * 100).toFixed(0)}%
                </span>}
              </div>
            );
          })}
        {scanning && (
          <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
            <div className="scanline absolute inset-x-0 h-24" />
          </div>
        )}
      </div>
    </div>
  );
}
