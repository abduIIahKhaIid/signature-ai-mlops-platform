import { Check, Loader2 } from "lucide-react";
import type { JobTrace } from "../lib/api";
import { ms } from "../lib/format";

interface Props {
  trace: JobTrace | null;
  /** Server-side timings, known once the job succeeded. */
  server?: { queue_wait: number | null; inference?: number; total_worker: number } | null;
  failed?: boolean;
  inferenceLabel?: string;
}

type StepState = "done" | "active" | "waiting" | "failed";

/**
 * The request's path through the system: upload to the API, wait in the Redis queue,
 * run on a Celery worker, come back. Live while the job runs, with measured times after.
 */
export function JobJourney({ trace, server, failed, inferenceLabel = "Model run on a worker" }: Props) {
  if (!trace) return null;
  const s = trace.status;
  const finished = s === "SUCCESS" || s === "FAILURE";
  const uploadMs = trace.acceptedAt ? trace.acceptedAt - trace.submittedAt : null;
  const totalMs = trace.finishedAt ? trace.finishedAt - trace.submittedAt : null;

  const state = (i: number): StepState => {
    if (failed) {
      // rejected at upload (bad type / size) or failed on the worker (bad image, error)
      const at = s === "UPLOADING" ? 0 : 2;
      return i < at ? "done" : i === at ? "failed" : "waiting";
    }
    const order = s === "UPLOADING" ? 0 : s === "PENDING" ? 1 : s === "STARTED" || s === "RETRY" ? 2 : 4;
    if (i < order) return "done";
    if (i === order) return "active";
    return "waiting";
  };

  const steps = [
    { title: "Upload to the API", value: ms(uploadMs) },
    { title: "Waiting in the queue", value: ms(server?.queue_wait ?? null) },
    {
      title: trace.retries ? `${inferenceLabel} (retried ${trace.retries}×)` : inferenceLabel,
      value: ms(server?.inference ?? server?.total_worker ?? null),
    },
    { title: "Result returned", value: finished ? ms(totalMs) : "—", note: finished ? "total" : undefined },
  ];

  return (
    <ol className="relative space-y-0" aria-label="Request progress">
      {steps.map((step, i) => {
        const st = state(i);
        return (
          <li key={step.title} className="relative flex items-start gap-3 pb-3 last:pb-0">
            {i < steps.length - 1 && (
              <span
                className={`absolute left-[11px] top-6 h-[calc(100%-18px)] w-[2px] ${st === "done" ? "bg-ink" : "bg-desk-line"}`}
                aria-hidden
              />
            )}
            <span
              className={`relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[12px] font-bold ${
                st === "done"
                  ? "bg-ink text-white"
                  : st === "active"
                    ? "bg-signal-soft text-signal ring-2 ring-signal"
                    : st === "failed"
                      ? "bg-fault text-white"
                      : "bg-desk text-ink-faint"
              }`}
            >
              {st === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : st === "active" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : i + 1}
            </span>
            <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 pt-0.5">
              <span className={st === "waiting" ? "text-ink-faint" : "text-ink"}>{step.title}</span>
              <span className="tnum whitespace-nowrap text-[14px] font-bold text-ink-soft">
                {step.value}
                {step.note && <span className="ml-1 font-normal text-ink-faint">{step.note}</span>}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
