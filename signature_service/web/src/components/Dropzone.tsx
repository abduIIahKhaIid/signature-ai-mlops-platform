import { useCallback, useEffect, useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import { ACCEPTED_TYPES, MAX_UPLOAD_MB } from "../lib/api";

export function checkFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) return `“${file.name}” is not a supported image. Use JPEG, PNG, WEBP, BMP or TIFF.`;
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return `“${file.name}” is larger than ${MAX_UPLOAD_MB} MB. Compress it or upload a smaller scan.`;
  return null;
}

interface Props {
  onFile: (file: File) => void;
  title: string;
  hint?: string;
  compact?: boolean;
  /** Listen for Ctrl+V / Cmd+V image paste anywhere on the page. */
  acceptPaste?: boolean;
  id?: string;
}

export function Dropzone({ onFile, title, hint, compact, acceptPaste, id }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = useCallback(
    (file?: File | null) => {
      if (!file) return;
      const problem = checkFile(file);
      setError(problem);
      if (!problem) onFile(file);
    },
    [onFile],
  );

  useEffect(() => {
    if (!acceptPaste) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items || []).find((i) => i.type.startsWith("image/"));
      if (item) take(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [acceptPaste, take]);

  return (
    <div className="h-full">
      <button
        type="button"
        id={id}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          take(e.dataTransfer.files?.[0]);
        }}
        className={`group flex h-full w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed text-center transition-colors ${
          compact ? "min-h-[220px] p-6" : "min-h-[460px] p-10"
        } ${over ? "border-signal bg-signal-soft" : "border-desk-line bg-paper/60 hover:border-ink-faint hover:bg-paper"}`}
      >
        <span className={`grid place-items-center rounded-full bg-desk ${compact ? "h-12 w-12" : "h-16 w-16"} transition-colors group-hover:bg-desk-deep`}>
          <ImageUp className={compact ? "h-6 w-6" : "h-8 w-8"} strokeWidth={1.75} aria-hidden />
        </span>
        <span className={`font-display font-semibold ${compact ? "text-lg" : "text-2xl"}`}>{title}</span>
        <span className="max-w-[46ch] text-ink-soft">
          {hint ?? "Drop an image here or click to choose one."} JPEG, PNG, WEBP, BMP or TIFF, up to {MAX_UPLOAD_MB} MB.
        </span>
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        className="sr-only"
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-fault-soft px-3 py-2 text-[14px] text-fault">
          {error}
        </p>
      )}
    </div>
  );
}
