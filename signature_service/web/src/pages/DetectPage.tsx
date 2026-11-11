import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeftRight, Download, FileJson, RotateCcw, Upload } from "lucide-react";
import { ApiError, detectForm, runJob, type DetectResult, type DetectSimilarity, type Detection, type JobTrace } from "../lib/api";
import { useObjectUrl } from "../lib/hooks";
import { bytes, confidenceBand, ms, versionDate } from "../lib/format";
import { Dropzone } from "../components/Dropzone";
import { DocumentSheet, type SheetBox } from "../components/DocumentSheet";
import { CropThumb } from "../components/CropThumb";
import { JobJourney } from "../components/JobJourney";

// Decision threshold: boxes under 10 % confidence are never shown. The server returns everything from 10 % up,
// and the slider raises the cut-off in the browser without a new request.
const MIN_THRESHOLD = 0.1;
const REQUEST_FLOOR = MIN_THRESHOLD;

type Phase = "idle" | "running" | "done" | "error";

const bandText = { verified: "text-verified", marker: "text-marker", caution: "text-caution" } as const;
const bandBar = { verified: "bg-verified", marker: "bg-marker", caution: "bg-caution" } as const;

async function downloadMarkedImage(src: string, result: DetectResult, shown: Detection[], name: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { width, height } = result.image_size;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, width, height);
  const line = Math.max(3, Math.round(Math.min(width, height) / 300));
  const font = Math.max(14, Math.round(Math.min(width, height) / 45));
  ctx.font = `700 ${font}px "Instrument Sans Variable", sans-serif`;
  shown.forEach((d, i) => {
    const [x1, y1, x2, y2] = d.box_xyxy;
    ctx.strokeStyle = "#D6245F";
    ctx.lineWidth = line;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const text = `Signature ${i + 1}  ${(d.score * 100).toFixed(0)}%`;
    const tw = ctx.measureText(text).width + font * 0.6;
    const ty = y1 - font * 1.4 < 0 ? y2 : y1 - font * 1.4;
    ctx.fillStyle = "#D6245F";
    ctx.fillRect(x1 - line / 2, ty, tw, font * 1.4);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x1 + font * 0.3 - line / 2, ty + font * 1.05);
  });
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (blob) save(blob, `${name.replace(/\.[^.]+$/, "")}_signatures.png`);
}

function save(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** Pairs of signatures on this page, compared by the similarity model (the same Siamese ResNet18 as the Verify page). */
function PairsPanel({
  similarity, shownCount, src, result, previewBroken, onActive,
}: {
  similarity: DetectSimilarity;
  shownCount: number;
  src: string;
  result: DetectResult;
  previewBroken: boolean;
  onActive: (i: number | null) => void;
}) {
  if (!similarity.available) {
    return (
      <div className="p-5">
        <h3 className="text-[17px] font-semibold">Do these signatures match each other?</h3>
        <p className="mt-1 text-[14px] text-ink-soft">The comparison is not available on this server: {similarity.reason}</p>
      </div>
    );
  }
  // detections are sorted by confidence, so the boxes above the slider are indexes 0 .. shownCount-1
  const pairs = (similarity.pairs ?? []).filter((p) => p.a < shownCount && p.b < shownCount);
  if (pairs.length === 0) return null;
  const threshold = similarity.threshold ?? 0.8;
  const matches = pairs.filter((p) => p.match).length;
  const best = pairs[0];
  const model = similarity.model === "resnet18-finetuned" ? "Siamese ResNet18" : similarity.model;
  return (
    <div className="p-5">
      <h3 className="text-[17px] font-semibold">Do these signatures match each other?</h3>
      <p className="mt-1 text-[14px] text-ink-soft">
        {matches === 0
          ? `No two signatures on this page look like the same writer. Closest pair: Signature ${best.a + 1} and ${best.b + 1} at ${best.score_percent.toFixed(1)}%.`
          : matches === 1
            ? `Signature ${best.a + 1} and Signature ${best.b + 1} look like the same writer (${best.score_percent.toFixed(1)}%).`
            : `${matches} pairs look like the same writer. The closest: Signature ${best.a + 1} and ${best.b + 1} (${best.score_percent.toFixed(1)}%).`}
      </p>
      <ul className="mt-3 max-h-[340px] space-y-2 overflow-y-auto pr-1" aria-label="Similarity of each pair of signatures">
        {pairs.map((p) => {
          const da = result.detections[p.a];
          const db = result.detections[p.b];
          return (
            <li
              key={`${p.a}-${p.b}`}
              tabIndex={0}
              onMouseEnter={() => onActive(p.a)}
              onMouseLeave={() => onActive(null)}
              onFocus={() => onActive(p.a)}
              onBlur={() => onActive(null)}
              className={`rounded-lg border p-2.5 ${p.match ? "border-verified/30 bg-verified-soft" : "border-desk-line bg-paper"}`}
            >
              <div className="flex items-center gap-2">
                {!previewBroken && <CropThumb src={src} box={da.box_xyxy} imageSize={result.image_size} alt={`Signature ${p.a + 1}`} maxW={82} maxH={44} />}
                <ArrowLeftRight className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                {!previewBroken && <CropThumb src={src} box={db.box_xyxy} imageSize={result.image_size} alt={`Signature ${p.b + 1}`} maxW={82} maxH={44} />}
                <span className="ml-auto text-right">
                  <span className="block font-display text-[22px] font-bold leading-none tnum">{p.score_percent.toFixed(1)}%</span>
                  <span className={`text-[12px] font-bold ${p.match ? "text-verified" : "text-ink-faint"}`}>{p.match ? "Same writer" : "Different"}</span>
                </span>
              </div>
              <div className="mt-1.5 text-[13px] text-ink-soft">Signature {p.a + 1} and Signature {p.b + 1}</div>
              <div className="relative mt-1 h-1.5 rounded-full bg-desk" aria-hidden>
                <div className={`h-full rounded-full ${p.match ? "bg-verified" : "bg-ink-faint"}`} style={{ width: `${Math.max(0, Math.min(1, p.similarity)) * 100}%` }} />
                <div className="absolute -top-1 h-3.5 w-[2px] bg-ink-soft" style={{ left: `${threshold * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[13px] text-ink-faint">
        {similarity.note ?? model} Match line at {(threshold * 100).toFixed(1)}%.
        {similarity.compared && similarity.detected && similarity.compared < similarity.detected
          ? ` Only the ${similarity.compared} most confident of ${similarity.detected} boxes were compared.`
          : ""}{" "}
        To check one signature against a known genuine one, use the <Link to="/verify" className="font-semibold text-signal underline underline-offset-4">Verify page</Link>.
      </p>
    </div>
  );
}

export default function DetectPage() {
  const [file, setFile] = useState<File | null>(null);
  const src = useObjectUrl(file);
  const [phase, setPhase] = useState<Phase>("idle");
  const [trace, setTrace] = useState<JobTrace | null>(null);
  const [result, setResult] = useState<DetectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(MIN_THRESHOLD);
  const [active, setActive] = useState<string | number | null>(null);
  const [previewBroken, setPreviewBroken] = useState(false);
  const [runId, setRunId] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const analyse = useCallback(async (f: File) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase("running");
    setResult(null);
    setError(null);
    setActive(null);
    try {
      const { result: r } = await runJob<DetectResult>(`/v1/detect?threshold=${REQUEST_FLOOR}`, detectForm(f), setTrace, ctrl.signal);
      setResult(r);
      setPhase("done");
      setRunId((n) => n + 1);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof ApiError ? e.message : `Something went wrong: ${(e as Error).message}`);
      setPhase("error");
    }
  }, []);

  const choose = useCallback(
    (f: File) => {
      setFile(f);
      setPreviewBroken(false);
      analyse(f);
    },
    [analyse],
  );

  const reset = () => {
    abort.current?.abort();
    setFile(null);
    setPhase("idle");
    setTrace(null);
    setResult(null);
    setError(null);
  };

  const shown = useMemo(() => (result ? result.detections.filter((d) => d.score >= threshold) : []), [result, threshold]);
  const hidden = (result?.detections.length ?? 0) - shown.length;
  const boxes: SheetBox[] = shown.map((d, i) => ({ key: i, detection: d, label: `Signature ${i + 1}` }));

  if (!file || !src) {
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-[34px] font-bold leading-tight tracking-tight">Find the signatures on a document</h1>
        <p className="mb-6 max-w-[62ch] text-[17px] text-ink-soft">
          Upload a scanned page or a photo. The model marks every signature it finds and tells you how sure it is about each one.
        </p>
        <Dropzone onFile={choose} title="Upload a document" hint="Drop an image here, click to choose one, or paste it with Ctrl+V." acceptPaste />
      </div>
    );
  }

  const running = phase === "running";
  const statusLine =
    trace?.status === "UPLOADING"
      ? "Uploading the image"
      : trace?.status === "PENDING"
        ? "Waiting for a free worker"
        : trace?.status === "RETRY"
          ? "A temporary problem occurred; the job is being retried"
          : "The model is reading the page";

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_400px]">
      <section aria-label="Document" className="min-w-0">
        {previewBroken ? (
          <div className="grid min-h-[420px] place-items-center rounded-xl border border-desk-line bg-paper p-8 text-center text-ink-soft">
            <p className="max-w-[48ch]">
              Your browser cannot preview this file type (often TIFF). The results on the right are still correct; download the marked image to see the boxes.
            </p>
          </div>
        ) : (
          <DocumentSheet
            src={src}
            alt={`Uploaded document ${file.name}`}
            imageSize={result?.image_size}
            boxes={phase === "done" ? boxes : []}
            active={active}
            onActive={setActive}
            scanning={running}
            revealKey={runId}
            onImageError={() => setPreviewBroken(true)}
          />
        )}
      </section>

      <aside className="panel h-fit divide-y divide-desk lg:sticky lg:top-[76px]" aria-label="Results">
        <div className="flex items-start justify-between gap-3 p-5">
          <div className="min-w-0">
            <p className="truncate font-bold" title={file.name}>{file.name}</p>
            <p className="text-[14px] text-ink-faint tnum">
              {bytes(file.size)}
              {result && `, ${result.image_size.width} × ${result.image_size.height} px`}
            </p>
          </div>
          <button type="button" className="btn-quiet shrink-0 px-3 py-1.5 text-[14px]" onClick={reset}>
            <Upload className="h-4 w-4" aria-hidden /> New image
          </button>
        </div>

        <div className="p-5" aria-live="polite">
          {running && (
            <>
              <h2 className="text-[26px] font-bold leading-tight">Looking for signatures</h2>
              <p className="mt-1 text-ink-soft">{statusLine}.</p>
            </>
          )}
          {phase === "error" && (
            <>
              <h2 className="text-[26px] font-bold leading-tight">The document was not analysed</h2>
              <p role="alert" className="mt-2 rounded-lg bg-fault-soft px-3 py-2 text-fault">{error}</p>
              <button type="button" className="btn-primary mt-3" onClick={() => analyse(file)}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Try again
              </button>
            </>
          )}
          {phase === "done" && result && (
            <>
              <h2 className="text-[26px] font-bold leading-tight">
                {shown.length === 0 ? "No signatures found" : shown.length === 1 ? "Found 1 signature" : `Found ${shown.length} signatures`}
              </h2>
              <p className="mt-1 text-ink-soft">
                {shown.length === 0
                  ? hidden > 0
                    ? `${hidden} weaker candidate${hidden > 1 ? "s are" : " is"} below ${Math.round(threshold * 100)}%. Lower the minimum confidence to see ${hidden > 1 ? "them" : "it"}.`
                    : "Nothing on this page looks like a signature to the model. A sharper or larger scan can help."
                  : `Showing boxes the model is at least ${Math.round(threshold * 100)}% sure about. Highest confidence: ${(shown[0].score * 100).toFixed(1)}%.`}
              </p>
              <div className="mt-4">
                <label htmlFor="threshold" className="field-label flex justify-between">
                  <span>Minimum confidence</span>
                  <span className="tnum text-ink">{Math.round(threshold * 100)}%</span>
                </label>
                <input
                  id="threshold"
                  type="range"
                  min={MIN_THRESHOLD}
                  max={0.95}
                  step={0.05}
                  value={threshold}
                  onChange={(e) => setThreshold(+e.target.value)}
                  className="mt-2 w-full accent-ink"
                />
                <p className="mt-1 text-[13px] text-ink-faint">
                  {hidden > 0 ? `${hidden} lower-confidence box${hidden > 1 ? "es" : ""} hidden.` : "Every box the model returned is shown."}
                </p>
              </div>
            </>
          )}
        </div>

        {phase === "done" && result && shown.length > 0 && (
          <ul className="max-h-[360px] space-y-1 overflow-y-auto p-3" aria-label="Detected signatures">
            {shown.map((d, i) => {
              const band = confidenceBand(d.score);
              const [x1, y1, x2, y2] = d.box_xyxy;
              return (
                <li
                  key={i}
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  tabIndex={0}
                  className={`flex items-center gap-3 rounded-lg p-2 transition-colors ${active === i ? "bg-marker-soft" : "hover:bg-desk"}`}
                >
                  {!previewBroken && <CropThumb src={src} box={d.box_xyxy} imageSize={result.image_size} alt={`Signature ${i + 1} close-up`} maxW={96} maxH={52} />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-bold">Signature {i + 1}</span>
                      <span className="tnum text-[15px] font-bold">{(d.score * 100).toFixed(1)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-desk" aria-hidden>
                      <div className={`h-full rounded-full ${bandBar[band.tone]}`} style={{ width: `${d.score * 100}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between gap-2 text-[13px]">
                      <span className={`font-bold ${bandText[band.tone]}`}>{band.label} confidence</span>
                      <span className="tnum whitespace-nowrap text-ink-faint" title={`Top-left corner at (${Math.round(x1)}, ${Math.round(y1)})`}>
                        {Math.round(x2 - x1)} × {Math.round(y2 - y1)} px
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {phase === "done" && result?.similarity && shown.length >= 2 && (
          <PairsPanel similarity={result.similarity} shownCount={shown.length} src={src} result={result} previewBroken={previewBroken} onActive={setActive} />
        )}

        {trace && (
          <div className="p-5">
            <h3 className="mb-3 text-[17px] font-semibold">How this request ran</h3>
            <JobJourney trace={trace} server={result?.timings_ms} failed={phase === "error"} />
            {result && (
              <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[14px]">
                <dt className="text-ink-faint">Model</dt>
                <dd className="truncate" title={result.model_version}>
                  {result.detector_model ?? "Detector"}{versionDate(result.model_version) ? `, trained ${versionDate(result.model_version)}` : ` ${result.model_version}`}
                </dd>
                <dt className="text-ink-faint">Worker</dt>
                <dd className="tnum">
                  process {result.worker_pid}
                  {result.retries ? `, ${result.retries} retr${result.retries > 1 ? "ies" : "y"}` : ""}
                </dd>
                {result.timings_ms.similarity != null && (
                  <>
                    <dt className="text-ink-faint">Pair comparison</dt>
                    <dd className="tnum">{ms(result.timings_ms.similarity)}</dd>
                  </>
                )}
                <dt className="text-ink-faint">Time on worker</dt>
                <dd className="tnum">{ms(result.timings_ms.total_worker)}</dd>
              </dl>
            )}
          </div>
        )}

        {phase === "done" && result && (
          <div className="flex flex-wrap gap-2 p-5">
            <button type="button" className="btn-primary" onClick={() => downloadMarkedImage(src, result, shown, file.name)} disabled={previewBroken}>
              <Download className="h-4 w-4" aria-hidden /> Download marked image
            </button>
            <button
              type="button"
              className="btn-quiet"
              onClick={() =>
                save(
                  new Blob([JSON.stringify({ file: file.name, min_confidence: threshold, ...result, detections: shown }, null, 2)], { type: "application/json" }),
                  `${file.name.replace(/\.[^.]+$/, "")}_signatures.json`,
                )
              }
            >
              <FileJson className="h-4 w-4" aria-hidden /> JSON
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}
