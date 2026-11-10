import { useRef, useState } from "react";
import { CheckCircle2, RotateCcw, ShieldAlert, X } from "lucide-react";
import { ApiError, runJob, verifyForm, type JobTrace, type VerifyResult, type VerifySide } from "../lib/api";
import { useObjectUrl } from "../lib/hooks";
import { ms, versionDate } from "../lib/format";
import { Dropzone } from "../components/Dropzone";
import { DocumentSheet } from "../components/DocumentSheet";
import { JobJourney } from "../components/JobJourney";

type Phase = "idle" | "running" | "done" | "error";

function Slot({
  title,
  hint,
  file,
  onFile,
  side,
  running,
  revealKey,
}: {
  title: string;
  hint: string;
  file: File | null;
  onFile: (f: File | null) => void;
  side?: VerifySide;
  running: boolean;
  revealKey: number;
}) {
  const src = useObjectUrl(file);
  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[19px] font-semibold">{title}</h2>
        {file && !running && (
          <button type="button" className="btn-quiet px-2.5 py-1 text-[13px]" onClick={() => onFile(null)}>
            <X className="h-3.5 w-3.5" aria-hidden /> Remove
          </button>
        )}
      </div>
      {file && src ? (
        <>
          <DocumentSheet
            src={src}
            alt={title}
            imageSize={side?.image_size}
            boxes={side?.detection ? [{ key: "sig", detection: side.detection, label: "Compared" }] : []}
            scanning={running}
            revealKey={revealKey}
            maxHeight="46vh"
          />
          <p className="mt-2 truncate text-center text-[13px] text-ink-faint" title={file.name}>
            {file.name}
            {side && (side.used_full_image ? ", no signature box found: the whole image was compared" : ", the marked region was compared")}
          </p>
        </>
      ) : (
        <Dropzone onFile={onFile} title="Add an image" hint={hint} compact />
      )}
    </div>
  );
}

function SimilarityScale({ value, threshold }: { value: number; threshold: number }) {
  const v = Math.max(0, Math.min(1, value));
  const t = Math.max(0, Math.min(1, threshold));
  return (
    <div className="mt-5">
      <div className="relative h-3 rounded-full bg-desk">
        <div className="absolute inset-y-0 right-0 rounded-r-full bg-verified-soft" style={{ left: `${t * 100}%` }} aria-hidden />
        <div className="absolute -top-1.5 h-6 w-[2px] bg-ink-soft" style={{ left: `${t * 100}%` }} aria-hidden />
        <div
          className={`absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white shadow ${value >= threshold ? "bg-verified" : "bg-marker"}`}
          style={{ left: `${v * 100}%` }}
          aria-hidden
        />
      </div>
      <div className="mt-2 flex justify-between text-[13px] text-ink-faint tnum">
        <span>0%</span>
        <span>100%</span>
      </div>
      <p className="mt-1 text-[13px] text-ink-soft">
        <span className="mr-1.5 inline-block h-3 w-[2px] translate-y-0.5 bg-ink-soft" aria-hidden />
        Match line at <strong className="tnum">{(threshold * 100).toFixed(1)}%</strong>: scores in the green part count as the same writer.
      </p>
    </div>
  );
}

export default function VerifyPage() {
  const [reference, setReference] = useState<File | null>(null);
  const [candidate, setCandidate] = useState<File | null>(null);
  const [crop, setCrop] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [trace, setTrace] = useState<JobTrace | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState(0);
  const abort = useRef<AbortController | null>(null);

  const clearResult = () => {
    setResult(null);
    setPhase("idle");
    setTrace(null);
    setError(null);
  };

  const compare = async () => {
    if (!reference || !candidate) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase("running");
    setResult(null);
    setError(null);
    try {
      const { result: r } = await runJob<VerifyResult>(`/v1/verify?crop=${crop}`, verifyForm(reference, candidate), setTrace, ctrl.signal);
      setResult(r);
      setPhase("done");
      setRunId((n) => n + 1);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof ApiError ? e.message : `Something went wrong: ${(e as Error).message}`);
      setPhase("error");
    }
  };

  const running = phase === "running";
  const ready = !!reference && !!candidate && !running;

  return (
    <div>
      <h1 className="mb-1 text-[34px] font-bold leading-tight tracking-tight">Compare two signatures</h1>
      <p className="mb-6 max-w-[66ch] text-[17px] text-ink-soft">
        Add a signature you know is genuine and the one you want to check. They can be cropped signatures or whole documents; the model finds the signature first.
      </p>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_380px]">
        <Slot
          title="Known genuine signature"
          hint="The reference: a signature you trust."
          file={reference}
          onFile={(f) => {
            setReference(f);
            clearResult();
          }}
          side={result?.reference}
          running={running}
          revealKey={runId}
        />
        <Slot
          title="Signature to check"
          hint="The questioned signature."
          file={candidate}
          onFile={(f) => {
            setCandidate(f);
            clearResult();
          }}
          side={result?.candidate}
          running={running}
          revealKey={runId}
        />

        <aside className="panel h-fit divide-y divide-desk" aria-label="Comparison">
          <div className="p-5">
            <label className="flex cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-1 h-4 w-4 accent-ink" checked={crop} onChange={(e) => setCrop(e.target.checked)} disabled={running} />
              <span>
                <span className="font-bold">Find the signature first</span>
                <span className="block text-[14px] text-ink-soft">Turn off if both images are already cropped to just the signature.</span>
              </span>
            </label>
            <button type="button" className="btn-primary mt-4 w-full" disabled={!ready} onClick={compare}>
              {running ? "Comparing" : phase === "done" ? <><RotateCcw className="h-4 w-4" aria-hidden /> Compare again</> : "Compare signatures"}
            </button>
            {!reference || !candidate ? (
              <p className="mt-2 text-center text-[13px] text-ink-faint">Add both images to compare them.</p>
            ) : null}
          </div>

          <div className="p-5" aria-live="polite">
            {phase === "idle" && <p className="text-ink-soft">The similarity score and the verdict appear here.</p>}
            {running && <h2 className="text-[24px] font-bold leading-tight">Comparing the two signatures</h2>}
            {phase === "error" && (
              <p role="alert" className="rounded-lg bg-fault-soft px-3 py-2 text-fault">{error}</p>
            )}
            {phase === "done" && result && (
              <>
                <div className={`flex items-start gap-3 rounded-lg p-3 ${result.match ? "bg-verified-soft" : "bg-marker-soft"}`}>
                  {result.match ? (
                    <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-verified" aria-hidden />
                  ) : (
                    <ShieldAlert className="mt-0.5 h-6 w-6 shrink-0 text-marker" aria-hidden />
                  )}
                  <div>
                    <h2 className="text-[22px] font-bold leading-tight">{result.match ? "Likely the same writer" : "Likely not the same writer"}</h2>
                    <p className="text-[14px] text-ink-soft">
                      {result.match
                        ? "The two signatures are as similar as genuine pairs usually are."
                        : "The difference is larger than between genuine pairs. This can be a forgery or another person's signature."}
                    </p>
                  </div>
                </div>
                <p className="mt-5 font-display text-[44px] font-bold leading-none tnum">
                  {result.score_percent.toFixed(1)}%
                  <span className="ml-2 align-middle font-sans text-[15px] font-normal text-ink-soft">similar</span>
                </p>
                <SimilarityScale value={result.similarity} threshold={result.threshold} />
                <p className="mt-3 text-[13px] text-ink-faint">{result.note}</p>
              </>
            )}
          </div>

          {trace && (
            <div className="p-5">
              <h3 className="mb-3 text-[17px] font-semibold">How this request ran</h3>
              <JobJourney trace={trace} server={result?.timings_ms} failed={phase === "error"} inferenceLabel="Detection and comparison on a worker" />
              {result && (
                <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[14px]">
                  <dt className="text-ink-faint">Similarity model</dt>
                  <dd className="truncate" title={result.similarity_version ?? ""}>
                    {result.similarity_model === "resnet18-finetuned" ? "Siamese ResNet18" : result.similarity_model}
                    {result.similarity_version && versionDate(result.similarity_version) ? `, trained ${versionDate(result.similarity_version)}` : ""}
                  </dd>
                  <dt className="text-ink-faint">Detector</dt>
                  <dd className="truncate" title={result.detector_version}>
                    RT-DETRv2{versionDate(result.detector_version) ? `, trained ${versionDate(result.detector_version)}` : ""}
                  </dd>
                  <dt className="text-ink-faint">Time on worker</dt>
                  <dd className="tnum">{ms(result.timings_ms.total_worker)}</dd>
                </dl>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
