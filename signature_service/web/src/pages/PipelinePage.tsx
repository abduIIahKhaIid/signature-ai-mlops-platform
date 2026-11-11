import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Minus, RefreshCw, Repeat, RotateCcw, Square, X } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usePolling } from "../lib/hooks";
import { ago, bytes, clock, duration, int, num4, pct, short, versionDate } from "../lib/format";
import {
  DECISION,
  RUN_STATUS,
  TONE_PILL,
  TRIGGER_SOURCE,
  type CometInfo,
  type DatasetSummary,
  type Overfitting,
  type PhaseDef,
  type PipelineState,
  type Run,
  type RunSummary,
  type AliasSummary,
  type TriggerRecord,
} from "../lib/pipeline";

const INK = "#16245A";
const MARKER = "#D6245F";
const OK = "#11815A";
const GRID = "#E6EAF0";

// ---------------------------------------------------------------- small building blocks
function Pill({ tone, children }: { tone: keyof typeof TONE_PILL; children: React.ReactNode }) {
  return <span className={`pill ${TONE_PILL[tone]}`}>{children}</span>;
}

function Section({ title, aside, children, id, className = "" }: { title: string; aside?: React.ReactNode; children: React.ReactNode; id?: string; className?: string }) {
  return (
    <section className={`panel flex min-w-0 flex-col p-5 ${className}`} aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-[20px] font-semibold">{title}</h2>
        {aside && <div className="text-[14px] text-ink-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-desk/60 px-4 py-6 text-center text-ink-faint">{children}</p>;
}

function Tile({ v, l, h, tone }: { v: React.ReactNode; l: string; h?: string; tone?: "bad" | "good" | "warn" }) {
  const color = tone === "bad" ? "text-fault" : tone === "good" ? "text-verified" : tone === "warn" ? "text-caution" : "";
  return (
    <div className="min-w-0 rounded-lg bg-desk/60 p-3">
      <dd className={`font-display text-[23px] font-bold leading-none tnum ${color}`}>{v}</dd>
      <dt className="mt-1 text-[13px] text-ink-soft">{l}</dt>
      {h && <div className="text-[12px] text-ink-faint">{h}</div>}
    </div>
  );
}

function Fact({ k, v, title, tone }: { k: string; v: React.ReactNode; title?: string; tone?: "good" }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-faint">{k}</dt>
      <dd className={`truncate font-bold ${tone === "good" ? "text-verified" : ""}`} title={title}>{v}</dd>
    </div>
  );
}

function Bar({ label, right, value, color = "bg-signal" }: { label: string; right: string; value: number; color?: string }) {
  return (
    <div>
      <div className="flex flex-wrap justify-between gap-2 text-[14px]">
        <span className="text-ink-soft">{label}</span>
        <span className="tnum text-ink-faint">{right}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-desk" role="progressbar" aria-label={label} aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-[width] duration-700 ${color}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

function secs(s?: number | null): string {
  if (typeof s !== "number" || !isFinite(s)) return "—";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} min`;
}

const isLive = (r?: Run | null) => !!r && (r.status === "running" || r.status === "deploying");

/** Can the Stop button act on this run? Mirrors the server rule (Kaggle job submitted, gate not started). */
function stoppable(state: PipelineState, run: Run | null): boolean {
  if (!run || run.status !== "running" || run.stop_requested_at) return false;
  if (run.phases.kaggle_submit?.status !== "done") return false;
  const gateIdx = state.phases.findIndex((p) => p.key === "gate");
  return !state.phases.slice(gateIdx).some((p) => ["running", "done"].includes(run.phases[p.key]?.status));
}

// ---------------------------------------------------------------- admin actions (token + confirmation)
type ActionKind = "check" | "force" | "stop" | "rollback" | "alerts" | "settings" | "promote";
interface PendingAction { kind: ActionKind; body?: Record<string, boolean | number | string | null>; runId?: string; needsReason?: boolean }

const ACTION_TEXT: Record<ActionKind, { title: string; intro: string; bullets?: string[]; confirm: string; danger?: boolean }> = {
  check: { title: "Check for a new dataset", intro: "This looks at the Hugging Face repo now instead of waiting for the webhook.", confirm: "Check now" },
  force: {
    title: "Retrain the newest dataset",
    intro: "This starts a Kaggle GPU run even if the newest dataset was already trained.",
    bullets: ["it uses Kaggle GPU quota (smoke ≈ 40 min, full a few hours)", "the gate still decides whether the new model is deployed"],
    confirm: "Retrain anyway",
    danger: true,
  },
  stop: {
    title: "Stop this training run?",
    intro: "The notebook stops safely at its next check (within about 30 seconds):",
    bullets: ["nothing is deployed, the current model keeps serving", "the dataset is not marked as trained, so it can run again", "Kaggle GPU time stops counting", "the stop is recorded in the event log"],
    confirm: "Stop run",
    danger: true,
  },
  rollback: {
    title: "Roll back the served model?",
    intro: "The serving alias goes back to the previous model. Workers switch within a few minutes; no model is deleted.",
    confirm: "Roll back",
    danger: true,
  },
  alerts: { title: "Change alert settings", intro: "Alert settings are shared by everyone who uses this dashboard.", confirm: "Save" },
  settings: { title: "Change training epochs", intro: "The new value is used from the next run. A run that is already training keeps its value.", confirm: "Save" },
  promote: {
    title: "Serve this candidate in production?",
    intro: "The production alias moves to the candidate. Workers load it at their next check; the current model is kept as the previous version for roll back.",
    bullets: ["a candidate that passed its validation gate is promoted with that verdict", "a candidate without a passed gate needs a reason; it is recorded as an admin override", "the promotion is recorded in the event log"],
    confirm: "Promote",
    danger: true,
  },
};

function useAdmin(onDone: () => void) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const saved = () => {
    try {
      return sessionStorage.getItem("pipelineAdminToken") || "";
    } catch {
      return "";
    }
  };

  const send = async (action: PendingAction, value: string) => {
    setBusy(true);
    setMessage(null);
    const url =
      action.kind === "check" || action.kind === "force"
        ? `/v1/pipeline/check?force=${action.kind === "force"}`
        : action.kind === "stop"
          ? `/v1/pipeline/stop${action.runId ? `?run_id=${encodeURIComponent(action.runId)}` : ""}`
          : `/v1/pipeline/${action.kind}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "X-Admin-Token": value, ...(action.body ? { "Content-Type": "application/json" } : {}) },
        body: action.body ? JSON.stringify(action.kind === "promote" ? { ...action.body, reason: note.trim() || null } : action.body) : undefined,
      });
      if (res.status === 401) {
        try {
          sessionStorage.removeItem("pipelineAdminToken");
        } catch {
          /* storage unavailable */
        }
        setMessage({ tone: "bad", text: "That admin token is not correct. It is PIPELINE_ADMIN_TOKEN in the server's .env file." });
        setToken("");
        setPending(action);
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
      try {
        sessionStorage.setItem("pipelineAdminToken", value);
      } catch {
        /* storage unavailable */
      }
      const done: Record<ActionKind, string> = {
        check: "Check requested. The decision appears below within a few seconds.",
        force: "Retraining requested. The run appears within a few seconds.",
        stop: "Stop requested. The notebook stops at its next check (about 30 seconds).",
        rollback: `Rolled back to ${body.to ?? "the previous model"}. Workers switch within a few minutes.`,
        alerts: "Alert settings saved.",
        settings: `Saved: the next run trains for up to ${body.epochs ?? "?"} epochs.`,
        promote: `Promoted ${body.model ?? ""} ${body.to ?? ""}${body.override ? " (admin override)" : ""}. Workers switch within a few minutes.`,
      };
      setMessage({ tone: "good", text: done[action.kind] });
      setPending(null);
      onDone();
    } catch (e) {
      setMessage({ tone: "bad", text: `${(e as Error).message}` });
      setPending(null);
    } finally {
      setBusy(false);
    }
  };

  /** Actions that change something ask for confirmation; the token is asked only when none is saved. */
  const request = (action: PendingAction) => {
    setMessage(null);
    const t = saved();
    const needsConfirm = ["stop", "rollback", "force", "promote"].includes(action.kind);
    setNote("");
    if (t && !needsConfirm) send(action, t);
    else {
      setToken(t);
      setPending(action);
    }
  };
  return { pending, setPending, token, setToken, message, busy, send, request, note, setNote };
}

function ActionDialog({ admin }: { admin: ReturnType<typeof useAdmin> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const a = admin.pending;
  useEffect(() => {
    if (a && !ref.current?.open) ref.current?.showModal();
    if (!a && ref.current?.open) ref.current?.close();
  }, [a]);
  const text = a ? ACTION_TEXT[a.kind] : null;
  return (
    <dialog ref={ref} onClose={() => admin.setPending(null)} className="w-[min(460px,92vw)] rounded-xl p-0 shadow-sheet backdrop:bg-ink/40">
      {a && text && (
        <form
          method="dialog"
          className="p-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (admin.token) admin.send(a, admin.token);
          }}
        >
          <h2 className="text-[22px] font-bold">{text.title}</h2>
          <p className="mt-1 text-ink-soft">{text.intro}</p>
          {text.bullets && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[14px] text-ink-soft">
              {text.bullets.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          {a.kind === "promote" && (
            <>
              <label htmlFor="promote-reason" className="field-label mt-4 block">
                Reason {a.needsReason ? <span className="text-fault">(required: this candidate has not passed its gate)</span> : <span className="text-ink-faint">(optional)</span>}
              </label>
              <textarea
                id="promote-reason"
                value={admin.note}
                onChange={(e) => admin.setNote(e.target.value)}
                maxLength={300}
                rows={2}
                className="mt-1 w-full rounded-lg border border-desk-line px-3 py-2 focus:border-signal"
                placeholder="e.g. checked by hand on 50 real documents"
              />
            </>
          )}
          <label htmlFor="admin-token" className="field-label mt-4 block">Admin token</label>
          <input
            id="admin-token"
            type="password"
            autoComplete="off"
            value={admin.token}
            onChange={(e) => admin.setToken(e.target.value)}
            className="mt-1 w-full rounded-lg border border-desk-line px-3 py-2 focus:border-signal"
            placeholder="PIPELINE_ADMIN_TOKEN from the server .env"
            autoFocus
          />
          {admin.message?.tone === "bad" && <p className="mt-2 text-[14px] text-fault">{admin.message.text}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => admin.setPending(null)}>{a.kind === "stop" ? "Keep running" : "Cancel"}</button>
            <button type="submit" className={text.danger ? "btn bg-fault text-white hover:brightness-110" : "btn-primary"} disabled={!admin.token || admin.busy || (a.kind === "promote" && !!a.needsReason && !admin.note.trim())}>
              {admin.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {text.confirm}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

// ---------------------------------------------------------------- run overview (hero)
function RunOverview({ state, run }: { state: PipelineState; run: Run | null }) {
  const phases = state.phases;
  if (!run) {
    return (
      <section className="panel p-6">
        <Pill tone="plain">Idle</Pill>
        <h2 className="mt-3 text-[30px] font-bold leading-tight">Waiting for a dataset upload</h2>
        <p className="mt-1 max-w-[70ch] text-ink-soft">
          Upload a reviewed dataset ZIP to {state.config.hf_repo ? <strong>{state.config.hf_repo}</strong> : "the Hugging Face dataset repo"}. The webhook starts a run here
          {state.config.poll_minutes ? `, and the repo is also checked every ${state.config.poll_minutes} minutes in case a webhook is missed` : ""}.
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact k="Last check" v={state.last_check ? `${ago(state.last_check.ts)}, ${state.last_check.source}` : "Never"} />
          <Fact k="Training mode" v={`${state.config.mode === "full" ? "Full dataset" : "Smoke test (small)"}${state.training ? ` · up to ${state.training.epochs} epoch${state.training.epochs > 1 ? "s" : ""}` : ""}`} />
          <Fact k="GPU" v={state.config.accelerator.replace("Nvidia", "NVIDIA ")} />
          <Fact k="Deploys to alias" v={state.config.deploy_alias} />
        </dl>
      </section>
    );
  }

  const ph = run.phases;
  const current = phases.find((p) => ph[p.key]?.status === "running");
  const stoppedAt = phases.find((p) => ph[p.key]?.status === "stopped");
  const failed = phases.find((p) => ph[p.key]?.status === "failed");
  const done = phases.filter((p) => ["done", "skipped"].includes(ph[p.key]?.status)).length;
  const live = isLive(run);
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "plain" as const };
  const L = run.live || {};
  const eps = L.epochs ?? [];
  const training = live && current?.key === "training";
  const epochNow = training ? Math.min(eps.length + 1, L.max_epochs ?? eps.length + 1) : eps.length;
  let title = live ? current?.label ?? "Working" : status.label;
  if (training) title = `Training the detection model · epoch ${epochNow} of ${L.max_epochs ?? "?"}`;
  if (run.status === "stopped" && stoppedAt) title = `Stopped during “${stoppedAt.label}”`;
  if (run.status === "failed" && failed) title = `Failed at: ${failed.label}`;
  if (live && run.stop_requested_at) title = "Stopping safely…";
  const bars = (L.progress || []).filter((p) => p.total > 0);
  const batchBar = bars.find((p) => /train/i.test(p.desc)) ?? bars[0];
  const fillColor = run.status === "failed" || run.status === "stopped" ? "bg-fault" : run.status === "succeeded" ? "bg-verified" : live ? "bg-ink" : "bg-caution";
  const eta = state.eta;
  const heartbeatOk = L.updated_at && Date.now() - Date.parse(L.updated_at) < 120_000;

  return (
    <section className="panel p-6">
      <div className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <Pill tone={status.tone}>
              {live && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {status.label}
            </Pill>
            <span className="text-[14px] text-ink-faint tnum">{run.id}</span>
          </div>
          <h2 className="mt-3 text-[30px] font-bold leading-tight">{title}</h2>
          <p className="mt-1 text-ink-soft">
            {run.trigger.source} trigger · {run.dataset.zip} ·{" "}
            {live ? (
              <>
                running for {duration(run.created_at)}
                {eta && <> · <strong>about {secs(eta.remaining_seconds)} left</strong></>}
              </>
            ) : (
              `finished ${ago(run.finished_at)} after ${duration(run.created_at, run.finished_at)}`
            )}
          </p>
          <div className="mt-5">
            <div className="flex justify-between text-[14px]">
              <span className="font-bold">Progress</span>
              <span className="tnum text-ink-soft">{done} of {phases.length} steps</span>
            </div>
            <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-desk" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={phases.length}>
              <div className={`h-full rounded-full transition-[width] duration-700 ${fillColor}`} style={{ width: `${(live ? done / phases.length : 1) * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="grid content-center gap-3">
          {live && batchBar && (
            <Bar
              label={batchBar.desc}
              right={`${int(batchBar.n)} / ${int(batchBar.total)}${batchBar.rate ? ` · ${batchBar.rate.toFixed(1)} it/s` : ""}${batchBar.rate ? ` · ETA ${secs((batchBar.total - batchBar.n) / batchBar.rate)}` : ""}${batchBar.postfix ? ` · ${batchBar.postfix}` : ""}`}
              value={(batchBar.n / batchBar.total) * 100}
            />
          )}
          {live && training && L.max_epochs ? (
            <Bar
              label="All epochs (early stopping may end sooner)"
              right={`${eps.length} / ${L.max_epochs}`}
              value={(eps.length / L.max_epochs) * 100}
              color="bg-[#7C95E6]"
            />
          ) : null}
          {!live && run.result?.gate && (
            <div className="rounded-lg bg-desk/60 p-3">
              <div className="text-[13px] text-ink-faint">Deployment decision</div>
              <div className={`font-bold ${run.result.gate.passed ? "text-verified" : "text-fault"}`}>
                {run.result.gate.passed ? (run.result.status === "deployed" ? "✓ Passed: deployed" : "✓ Passed, not deployed") : `✕ ${(run.result.gate.reasons || []).join("; ")}`}
              </div>
            </div>
          )}
          {run.status === "stopped" && <div className="rounded-lg bg-fault-soft p-3 font-bold text-fault">Stopped by {run.stop_requested_by ?? "admin"}: nothing was deployed; the dataset can be trained again.</div>}
          {live && run.stop_requested_at && (
            <div className="rounded-lg bg-caution-soft p-3 text-caution">
              <strong>Stop requested</strong> {ago(run.stop_requested_at)} by {run.stop_requested_by}. The notebook stops at its next check.
            </div>
          )}
        </div>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-desk pt-4 sm:grid-cols-3 xl:grid-cols-6">
        <Fact k="Trigger" v={`${run.trigger.source}${run.trigger.force ? " (forced)" : ""}${run.trigger.hf_sha ? ` · ${run.trigger.hf_sha.slice(0, 7)}` : ""}`} />
        <Fact k="Mode" v={`${run.mode === "full" ? "Full retrain" : "Smoke test"}${run.live?.max_epochs || run.epochs ? ` · ${run.live?.max_epochs ?? run.epochs} epoch${(run.live?.max_epochs ?? run.epochs) === 1 ? "" : "s"} max` : ""}`} />
        <Fact k="Started from" v={run.served_before ? versionDate(run.served_before) ?? short(run.served_before, 26) : "Served model"} title={run.served_before ?? undefined} />
        <Fact k="Kaggle" v={run.kaggle.status ? `${run.kaggle.status}${run.kaggle.version ? ` · version ${run.kaggle.version}` : ""}` : "—"} />
        <Fact k="GPU" v={L.gpu?.name ? `${L.gpu.name}${L.gpu.allocated_gb != null ? ` · ${L.gpu.allocated_gb} GB` : ""}` : "—"} />
        <Fact k="Notebook heartbeat" v={L.updated_at ? ago(L.updated_at) : "—"} tone={live && heartbeatOk ? "good" : undefined} />
      </dl>
    </section>
  );
}

// ---------------------------------------------------------------- steps
function Steps({ phases, run, eta }: { phases: PhaseDef[]; run: Run | null; eta: PipelineState["eta"] }) {
  let lastGroup = "";
  let n = 0;
  return (
    <>
      <ol aria-label="Pipeline steps">
        {phases.map((p, i) => {
          const st = run?.phases[p.key] ?? { status: "pending" as const };
          const group = p.where.includes("Kaggle") ? "kaggle" : "ec2";
          const header = group !== lastGroup ? (group === "kaggle" ? "On Kaggle (T4 GPU notebook)" : lastGroup ? "Back on EC2" : "On EC2 (orchestrator)") : null;
          lastGroup = group;
          n += 1;
          const time = st.status === "running" ? duration(st.started_at) : st.status !== "skipped" && st.started_at && st.ended_at ? duration(st.started_at, st.ended_at) : "";
          const last = i === phases.length - 1;
          return (
            <li key={p.key}>
              {header && <p className={`pb-2 text-[13px] font-bold text-ink-faint ${i ? "pt-3" : ""}`}>{header}</p>}
              <div className="relative flex gap-3 pb-3">
                {!last && <span className={`absolute left-[11px] top-6 h-[calc(100%-14px)] w-[2px] ${st.status === "done" ? "bg-ink" : "bg-desk-deep"}`} aria-hidden />}
                <span
                  className={`relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                    st.status === "done"
                      ? "bg-ink text-white"
                      : st.status === "running"
                        ? "bg-signal-soft text-signal ring-2 ring-signal"
                        : st.status === "failed"
                          ? "bg-fault text-white"
                          : st.status === "stopped"
                            ? "bg-caution text-white"
                            : st.status === "skipped"
                              ? "bg-desk text-ink-faint"
                              : "bg-paper text-ink-faint ring-1 ring-desk-line"
                  }`}
                  aria-label={st.status}
                >
                  {st.status === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : st.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : st.status === "failed" ? <X className="h-3.5 w-3.5" strokeWidth={3} /> : st.status === "stopped" ? <Square className="h-3 w-3" fill="currentColor" /> : st.status === "skipped" ? <Minus className="h-3.5 w-3.5" /> : n}
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`leading-snug ${st.status === "pending" || st.status === "skipped" ? "text-ink-faint" : st.status === "running" ? "font-bold text-signal" : ""}`}>{p.label}</span>
                    <span className="tnum shrink-0 text-[13px] text-ink-faint">{time}</span>
                  </div>
                  {st.detail && <p className={`mt-0.5 break-words text-[13px] ${st.status === "failed" ? "text-fault" : "text-ink-soft"}`}>{st.detail}</p>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {eta && (
        <p className="mt-1 text-[13px] text-ink-faint">
          Estimated finish <strong className="text-ink">{clock(eta.finish_at).slice(0, 5)}</strong> ·{" "}
          {eta.basis === "history" ? `median step times of ${eta.runs_used} earlier run${eta.runs_used > 1 ? "s" : ""}` : "typical step times (no earlier run in this mode yet)"}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- live training
function liveLoss(run: Run): number | null {
  const bar = (run.live?.progress || []).find((p) => /train/i.test(p.desc));
  const m = bar?.postfix && /loss=([\d.]+)/.exec(bar.postfix);
  return m ? parseFloat(m[1]) : null;
}

function TrainingCard({ state, run }: { state: PipelineState; run: Run | null }) {
  const eps = run?.live?.epochs ?? [];
  const bestIdx = eps.reduce((b, e, i) => ((e.val_map50 ?? -1) > (eps[b]?.val_map50 ?? -1) ? i : b), 0);
  const best = eps[bestIdx];
  const sinceBest = eps.length ? eps.length - 1 - bestIdx : 0;
  const bar = (run?.live?.progress || []).find((p) => /train/i.test(p.desc));
  const now = run && isLive(run) ? liveLoss(run) : null;
  const served = state.lineage?.serving;
  const servedMap = state.runs.find((r) => r.version && r.version === served)?.test_map50;
  const chart = (lines: { key: "train_loss" | "val_loss" | "val_map50"; name: string; color: string }[], domain?: [number | string, number | string], ref?: number | null) => (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={eps} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="epoch" tick={{ fontSize: 12, fill: "#6B7493" }} tickLine={false} axisLine={{ stroke: "#C3CBD7" }} label={{ value: "epoch", position: "insideBottomRight", offset: -2, fontSize: 12, fill: "#6B7493" }} />
          <YAxis domain={domain ?? ["auto", "auto"]} tick={{ fontSize: 12, fill: "#6B7493" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(2)} width={48} />
          <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(4) : String(v))} labelFormatter={(l) => `Epoch ${l}`} contentStyle={{ borderRadius: 8, border: "1px solid #C3CBD7", fontSize: 13 }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 13 }} />
          {ref != null && <ReferenceLine y={ref} stroke={OK} strokeDasharray="5 4" label={{ value: `current model ${ref.toFixed(3)} (test)`, position: "insideTopRight", fill: OK, fontSize: 12 }} />}
          {lines.map((l) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2.5} dot={{ r: 3.5, strokeWidth: 0, fill: l.color }} activeDot={{ r: 5 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
  return (
    <Section title="Live training" id="train" aside={best ? `best so far: epoch ${best.epoch}, validation mAP@50 ${num4(best.val_map50)}` : undefined}>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        <Tile v={now != null ? now.toFixed(2) : eps.length ? num4(eps[eps.length - 1].train_loss).slice(0, 5) : "—"} l={now != null ? "Training loss (now)" : "Training loss (last epoch)"} />
        <Tile v={best ? num4(best.val_map50) : "—"} l="Best val mAP@50" />
        <Tile v={eps.length && eps[eps.length - 1].learning_rate != null ? eps[eps.length - 1].learning_rate!.toExponential(0) : "—"} l="Learning rate" />
        <Tile v={bar?.rate ? `${bar.rate.toFixed(1)} it/s` : "—"} l="Speed" />
        <Tile v={eps.length ? `${sinceBest}` : "—"} l="Epochs since best" h="early stopping ends training when this reaches its patience" />
      </dl>
      {eps.length === 0 ? (
        <Empty>Loss and accuracy curves appear after the first epoch. Every metric is also logged to Comet.</Empty>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h3 className="mb-1 text-[15px] font-bold">Loss per epoch (lower is better)</h3>
            {chart([{ key: "train_loss", name: "Training", color: INK }, { key: "val_loss", name: "Validation", color: MARKER }])}
          </div>
          <div>
            <h3 className="mb-1 text-[15px] font-bold">Validation mAP@50 (higher is better)</h3>
            {chart([{ key: "val_map50", name: "mAP@50", color: INK }], [0, 1], servedMap)}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- Comet
function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const v = values.filter((x): x is number => typeof x === "number");
  if (v.length < 2) return <span className="text-ink-faint">·</span>;
  const lo = Math.min(...v), hi = Math.max(...v);
  const pts = v.map((x, i) => `${2 + (i / (v.length - 1)) * 66},${15 - ((x - lo) / (hi - lo || 1)) * 12}`).join(" ");
  return <svg width="70" height="18" aria-hidden><polyline points={pts} fill="none" stroke={color} strokeWidth="2" /></svg>;
}

const KEY_METRICS = ["train_loss", "val_loss", "val_map50", "best_val_map50", "learning_rate", "test_map50", "test_map",
  "val_test_map50_gap", "calib_precision", "calib_recall", "epoch_seconds", "gpu_peak_allocated_gb"];

const mfmt = (v?: number | null) => (typeof v === "number" && v !== 0 && Math.abs(v) < 0.001 ? v.toExponential(1) : num4(v ?? undefined));

function CometCard({ state, run }: { state: PipelineState; run: Run | null }) {
  const [tab, setTab] = useState<"metrics" | "params" | "console" | "files">("metrics");
  const c: CometInfo = run?.comet || {};
  const data = run?.live?.data || {};
  const key = c.key || data.comet_key || null;
  const url = c.url || data.comet_url || run?.result?.comet_url || (key && state.config.comet_project_url ? `${state.config.comet_project_url}/${key}` : null);
  const project = state.config.comet_project;
  const aside = (
    <span>
      <span className="text-ink-faint">{state.config.comet_workspace ? `${state.config.comet_workspace} / ` : ""}{project}{key ? " / " : ""}</span>
      {key && <strong className="text-ink">{short(key, 10)}</strong>}
      {(url || state.config.comet_project_url) && (
        <a className="ml-2 inline-flex items-center gap-1 font-bold text-signal" href={url || state.config.comet_project_url!} target="_blank" rel="noreferrer">
          Open in Comet <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        </a>
      )}
    </span>
  );
  let body: React.ReactNode;
  if (!run || !key) {
    body = <Empty>The Comet experiment starts with training. Its metrics, parameters, console output and files appear here.</Empty>;
  } else if (state.config.comet_enabled === false) {
    body = (
      <Empty>
        The experiment is recording in Comet{url ? "" : " (link appears once training starts)"}. To show it here too, add <strong>COMET_API_KEY</strong> and <strong>COMET_WORKSPACE</strong> to the server's <code>.env</code>.
      </Empty>
    );
  } else if (c.error && !c.metrics) {
    body = <p className="rounded-lg bg-fault-soft px-4 py-3 text-fault">Comet could not be read: {c.error}</p>;
  } else if (tab === "metrics") {
    const all = (c.metrics || []).filter((m) => !/^sys\.|^system/i.test(m.name));
    const rank = (n: string) => { const i = KEY_METRICS.indexOf(n); return i < 0 ? 999 : i; };
    const sorted = [...all].sort((x, y) => rank(x.name) - rank(y.name) || x.name.localeCompare(y.name));
    const metrics = sorted;
    body = metrics.length ? (
      <div>
        <table className="w-full min-w-[520px] text-left text-[14px]">
          <thead className="sticky top-0 z-10 bg-paper text-[13px] text-ink-faint shadow-[0_1px_0_#E6EAF0]">
            <tr><th className="pb-2 font-normal">Metric</th><th className="pb-2 text-right font-normal">Latest</th><th className="pb-2 text-right font-normal">Best</th><th className="pb-2 pl-4 font-normal">Trend</th><th className="pb-2 font-normal">Step</th></tr>
          </thead>
          <tbody className="divide-y divide-desk">
            {metrics.map((m) => {
              const lowerBetter = /loss|seconds/.test(m.name);
              const bestV = lowerBetter ? m.min : m.max;
              return (
                <tr key={m.name}>
                  <td className="py-1.5 font-code text-[13px]">{m.name}</td>
                  <td className="py-1.5 text-right tnum">{mfmt(m.latest)}</td>
                  <td className="py-1.5 text-right tnum">{/seconds|gpu|learning_rate/.test(m.name) ? "—" : mfmt(bestV)}</td>
                  <td className="py-1.5 pl-4">{m.history ? <Spark values={m.history} color={m.name === "val_loss" ? MARKER : INK} /> : null}</td>
                  <td className="py-1.5 text-ink-faint">{m.step ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    ) : (
      <Empty>Experiment created. Per-epoch metrics arrive at the end of every epoch.</Empty>
    );
  } else if (tab === "params") {
    const entries = Object.entries(c.params || {});
    body = entries.length ? (
      <dl className="grid grid-cols-[minmax(160px,auto)_1fr] gap-x-6 gap-y-1.5 text-[14px]">
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-code text-[13px] text-ink-faint">{k}</dt>
            <dd className="break-all">{String(v)}</dd>
          </div>
        ))}
      </dl>
    ) : (
      <Empty>No parameters logged yet.</Empty>
    );
  } else if (tab === "console") {
    body = <Terminal height="" lines={(c.console || []).map((l) => ({ line: l }))} empty="Comet has not received console output yet." />;
  } else {
    body = (c.assets || []).length ? (
      <ul className="divide-y divide-desk text-[14px]">
        {(c.assets || []).map((a, i) => (
          <li key={`${a.name}-${i}`} className="flex justify-between gap-3 py-1.5">
            <span className="break-all font-code text-[13px]">{a.name}</span>
            <span className="shrink-0 text-ink-faint">{a.type}{a.size ? ` · ${bytes(a.size)}` : ""}</span>
          </li>
        ))}
      </ul>
    ) : (
      <Empty>Files (curves, reports, history) are attached as the run produces them.</Empty>
    );
  }
  return (
    <Section title="Comet experiment" id="comet" aside={aside}>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-desk" role="tablist" aria-label="Comet views">
        {(["metrics", "params", "console", "files"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-1.5 text-[14px] font-bold ${tab === t ? "border-ink text-ink" : "border-transparent text-ink-faint hover:text-ink"}`}
          >
            {{ metrics: `Metrics${c.metrics?.length ? ` (${c.metrics.length})` : ""}`, params: "Parameters", console: "Console output", files: "Files & charts" }[t]}
          </button>
        ))}
      </div>
      <div className="max-h-[340px] overflow-auto overscroll-contain pr-1" tabIndex={0} aria-label="Comet data, scrolls">
        {body}
      </div>
      {c.fetched_at && <p className="mt-2 text-[12px] text-ink-faint">Read from the Comet API {ago(c.fetched_at)}; you do not need to sign in to Comet to watch.</p>}
    </Section>
  );
}

function Terminal({ lines, empty, height = "max-h-[300px]", fill = false }: { lines: { ts?: string; line: string; tone?: string }[]; empty: string; height?: string; fill?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  const term = (
    <div
      ref={box}
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
      className={`${fill ? "absolute inset-0" : `${height} min-h-[120px]`} overflow-y-auto rounded-lg bg-ink px-4 py-3 font-code text-[12.5px] leading-relaxed text-white/85`}
    >
      {lines.length === 0 ? (
        <p className="text-white/60">{empty}</p>
      ) : (
        lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${l.tone ?? ""}`}>
            {l.ts && <span className="mr-2 text-white/45">{clock(l.ts)}</span>}
            {l.line}
          </div>
        ))
      )}
    </div>
  );
  // fill: the card grows to the height of its column, and the log scrolls inside it
  return fill ? <div className="relative min-h-[300px] flex-1">{term}</div> : term;
}

function NotebookOutput({ run, live, fill = false, className = "" }: { run: Run | null; live: boolean; fill?: boolean; className?: string }) {
  const console_ = run?.live?.console || [];
  const lines = console_.map((c) => ({
    ts: c.ts,
    line: c.line,
    tone: /error|traceback|exception|failed/i.test(c.line)
      ? "text-[#FF9A9A]"
      : /warning|note:|no meaningful|early stopping|stop/i.test(c.line) || c.stream === "stderr"
        ? "text-[#FFD48A]"
        : /\bok\b|saved best|pass|verified/i.test(c.line)
          ? "text-[#8FE0B6]"
          : "",
  }));
  // A run that failed before the notebook could report its own error: show the end of the Kaggle log as well.
  if (run?.status === "failed" && run.log_tail && !console_.some((c) => /traceback/i.test(c.line))) {
    lines.push({ ts: run.finished_at ?? "", line: "──── end of the Kaggle log ────", tone: "text-white/50" });
    for (const l of run.log_tail.split("\n").filter((x) => x.trim()).slice(-40)) {
      lines.push({ ts: "", line: l, tone: /error|traceback|exception/i.test(l) ? "text-[#FF9A9A]" : "text-white/70" });
    }
  }
  return (
    <Section
      title={live ? "Notebook output (live)" : "Notebook output"}
      id="nb"
      className={className}
      aside={live ? "what the Kaggle notebook prints, every few seconds, auto-scroll" : run ? "everything the Kaggle notebook printed in this run" : undefined}
    >
      <Terminal fill={fill} height="max-h-[300px]" lines={lines} empty={run ? "The notebook's output appears here as soon as it starts on Kaggle." : "No run yet."} />
    </Section>
  );
}

// ---------------------------------------------------------------- dataset, cleaning, lineage
function diffTile(now?: number, before?: number, label = "") {
  if (typeof now !== "number" || typeof before !== "number") return null;
  const d = now - before;
  return <Tile key={label} v={`${d >= 0 ? "+" : "−"}${int(Math.abs(d))}`} l={label} tone={d > 0 ? "good" : d < 0 ? "bad" : undefined} />;
}
const boxes = (s?: DatasetSummary) => (s?.final_splits ? Object.values(s.final_splits).reduce((a, b) => a + (b.boxes ?? 0), 0) : undefined);

function DatasetCard({ state, run }: { state: PipelineState; run: Run | null }) {
  if (!run) {
    const lc = state.last_check;
    return (
      <Section title="Dataset" id="ds">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
          <dt className="text-ink-faint">Repository</dt>
          <dd>{state.config.hf_url ? <a className="font-bold underline decoration-desk-line underline-offset-4 hover:decoration-ink" href={state.config.hf_url} target="_blank" rel="noreferrer">{state.config.hf_repo}</a> : "Not configured"}</dd>
          {lc && (
            <>
              <dt className="text-ink-faint">Last commit seen</dt>
              <dd className="tnum">{short(lc.commit, 10)}</dd>
              <dt className="text-ink-faint">ZIP files found</dt>
              <dd>{lc.zips.length ? lc.zips.map((z) => z.path).join(", ") : "None"}</dd>
            </>
          )}
        </dl>
      </Section>
    );
  }
  const ds = run.dataset;
  const nb = run.live?.data?.dataset;
  const now = run.live?.data?.dataset_summary;
  const prev = state.previous_dataset;
  const diffs = now && prev ? [
    diffTile(now.source_images, prev.summary.source_images, "images vs last dataset"),
    diffTile(now.after_leakage_quarantine ?? now.after_exact_dedupe, prev.summary.after_leakage_quarantine ?? prev.summary.after_exact_dedupe, "clean images"),
    diffTile(boxes(now), boxes(prev.summary), "signature boxes"),
  ].filter(Boolean) : [];
  return (
    <Section title="Dataset" id="ds" aside={<a className="inline-flex items-center gap-1 font-bold text-signal" href={ds.url} target="_blank" rel="noreferrer">Open on Hugging Face <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-ink-faint">File</dt>
        <dd className="break-all font-bold">{ds.zip} <span className="font-normal text-ink-faint">{bytes(ds.size_bytes)}</span></dd>
        <dt className="text-ink-faint">Uploaded</dt>
        <dd>{ds.committed_at ? new Date(ds.committed_at).toLocaleString() : "—"}{ds.commit_title ? <span className="text-ink-faint"> “{ds.commit_title}”</span> : null}</dd>
        <dt className="text-ink-faint">Content hash</dt>
        <dd className="tnum" title={ds.fingerprint}>SHA-256 {short(ds.fingerprint, 16)}</dd>
        <dt className="text-ink-faint">Integrity</dt>
        <dd>{nb?.sha256 ? (nb.sha256_verified ? <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> Verified on Kaggle</Pill> : <Pill tone="plain">Computed on Kaggle</Pill>) : <span className="text-ink-faint">Checked when Kaggle downloads the file</span>}</dd>
      </dl>
      <div className="mt-4 border-t border-desk pt-3">
        <p className="mb-2 font-bold">Compared with the last trained dataset</p>
        {diffs.length ? (
          <dl className="grid grid-cols-3 gap-2">{diffs}</dl>
        ) : (
          <p className="text-[14px] text-ink-faint">{prev ? "Appears once this dataset has been cleaned." : "No earlier dataset to compare with yet."}</p>
        )}
        {prev && <p className="mt-1.5 text-[12px] text-ink-faint">Previous: {prev.zip}</p>}
      </div>
    </Section>
  );
}

function CleaningCard({ run }: { run: Run | null }) {
  const s = run?.live?.data?.dataset_summary;
  if (!s) return <Section title="Data cleaning" id="clean"><Empty>The cleaning report appears once Kaggle has checked the dataset.</Empty></Section>;
  const fs = s.final_splits || {};
  const splits = (["train", "valid", "test"] as const).map((k) => ({ k, images: fs[k]?.images ?? 0, boxes: fs[k]?.boxes ?? 0 }));
  const invalid = (s.source_images ?? 0) - (s.valid_images ?? 0);
  const splitColor = { train: "bg-ink", valid: "bg-[#6250d6]", test: "bg-[#1baf7a]" };
  return (
    <Section
      title="Data cleaning"
      id="clean"
      aside={s.leakage_gate_passed ? <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> No leakage between splits</Pill> : <Pill tone="bad">Leakage check failed</Pill>}
    >
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Tile v={int(s.source_images)} l="images in ZIP" />
        <Tile v={int(invalid)} l="invalid / bad boxes" tone={invalid > 0 ? "bad" : undefined} />
        <Tile v={int(s.exact_removed)} l="exact duplicates" tone={(s.exact_removed ?? 0) > 0 ? "bad" : undefined} />
        <Tile v={int(s.exact_cross_split_removed)} l="train↔test leaks" tone={(s.exact_cross_split_removed ?? 0) > 0 ? "bad" : undefined} />
        <Tile v={int(s.near_confirmed_pairs)} l="near-duplicates" />
        <Tile v={int(s.after_leakage_quarantine ?? s.after_exact_dedupe)} l="clean images" tone="good" />
      </dl>
      <div className="mt-3 flex h-7 gap-0.5 overflow-hidden rounded-lg text-[12px] font-bold text-white" role="img" aria-label={splits.map((x) => `${x.k} ${x.images} images`).join(", ")}>
        {splits.map((x) => (
          <div key={x.k} className={`flex min-w-[76px] items-center justify-center px-2 ${splitColor[x.k]}`} style={{ flex: x.images || 0.0001 }} title={`${x.k}: ${x.images} images, ${x.boxes} boxes`}>
            <span className="truncate">{x.k === "valid" ? "val" : x.k} {int(x.images)}</span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[13px] text-ink-faint">Every removed file is listed in the Kaggle reports (CSV) and attached in Comet.</p>
    </Section>
  );
}

/** What the inference workers serve right now, the candidate waiting behind it, and the Promote action. */
function gateBadge(alias?: AliasSummary | null) {
  if (!alias?.version) return null;
  const g = alias.gate;
  if (!g) return <Pill tone="warn">no gate record</Pill>;
  if (g.passed) return <Pill tone="good">gate passed</Pill>;
  if (g.override) return <Pill tone="live">admin override</Pill>;
  return <Pill tone="bad">gate rejected</Pill>;
}

function ServingModelsCard({ state, admin }: { state: PipelineState; admin: ReturnType<typeof useAdmin> }) {
  const sv = state.serving;
  if (!sv) return null;
  const w = sv.worker;
  const label = (v?: string | null) => (v ? versionDate(v) ?? v : "—");
  const simName = w?.similarity_model === "resnet18-finetuned" ? "Siamese ResNet18" : w?.similarity_model ?? null;
  const models: { key: "detection" | "similarity"; name: string; serving: React.ReactNode; detail?: string; error?: string | null }[] = [
    { key: "detection", name: "Detector", serving: label(w?.detector_version), detail: w?.detector_model ?? undefined, error: w?.last_detector_reload_error },
    {
      key: "similarity",
      name: "Similarity",
      serving: w?.similarity_version ? label(w.similarity_version) : simName ? "built-in weights" : "not loaded",
      detail: simName ? `${simName}${w?.similarity_threshold != null ? `, match line ${(w.similarity_threshold * 100).toFixed(1)}%` : ""}` : undefined,
      error: w?.last_similarity_reload_error,
    },
  ];
  return (
    <Section title="Models on the workers" id="serving" aside={sv.checked_at ? `checked ${ago(sv.checked_at)}` : undefined}>
      {sv.worker_error && !w && <p className="mb-2 rounded-lg bg-fault-soft px-3 py-2 text-[14px] text-fault">No worker answered: {sv.worker_error}</p>}
      <div className="grid gap-3">
        {models.map((m) => {
          const prod = sv.aliases?.[m.key]?.production;
          const cand = sv.aliases?.[m.key]?.latest;
          const follows = sv.following?.[m.key];
          // versions are named v<UTC timestamp>-<id>, so a string compare is a time compare: an older candidate
          // (e.g. after the gate promoted a newer pipeline run) is not offered for promotion
          const waiting = !!cand?.version && cand.version !== prod?.version && (!prod?.version || cand.version > prod.version);
          const candPassed = !!cand?.gate?.passed;
          return (
            <div key={m.key} className={`rounded-lg p-3 ${m.error ? "bg-fault-soft" : "bg-desk/60"}`}>
              <div className="text-[13px] text-ink-faint">{m.name}{m.detail ? ` · ${m.detail}` : ""}</div>
              <div className="break-all font-bold">{m.serving}</div>
              {follows && follows !== "production" && (
                <p className="mt-1 text-[12.5px] font-semibold text-caution">
                  Workers follow “{follows}”: any notebook run goes live without a gate. Set {m.key === "detection" ? "MODEL_ALIAS" : "SIMILARITY_S3_ALIAS"}=production.
                </p>
              )}
              <dl className="mt-2 grid gap-1 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <dt className="text-ink-faint">Production</dt>
                  <dd className="font-semibold">{label(prod?.version)}</dd>
                  {gateBadge(prod)}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <dt className="text-ink-faint">Candidate</dt>
                  <dd className="font-semibold">{waiting ? label(cand?.version) : "same as production"}</dd>
                  {waiting && (cand?.gate ? gateBadge(cand) : <Pill tone="plain">not gated</Pill>)}
                </div>
              </dl>
              {m.error && <p className="mt-1 break-words text-[12.5px] text-fault [overflow-wrap:anywhere]">Hot reload problem: {m.error}</p>}
              {waiting && (
                <button
                  type="button"
                  className="btn-quiet mt-2 px-3 py-1.5 text-[13px]"
                  disabled={!state.config.admin_enabled || admin.busy}
                  onClick={() => admin.request({ kind: "promote", body: { model: m.key, version: cand?.version ?? null }, needsReason: !candPassed })}
                >
                  Promote candidate{candPassed ? "" : " (override)"}
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[12.5px] text-ink-faint">
        Notebooks write candidates to “latest”. Only a validation gate or an admin can move “production”, and workers refuse a production alias without a gate record. Workers re-check every {secs(w?.hot_reload_poll_seconds ?? state.config.model_poll_seconds ?? 300)}.
      </p>
    </Section>
  );
}

function LineageCard({ state }: { state: PipelineState }) {
  const lin = state.lineage;
  if (!lin) return null;
  const node = (key: string, title: React.ReactNode, sub: React.ReactNode, kind: "plain" | "live" | "cur" | "rej" = "plain") => (
    <div
      key={key}
      className={`rounded-lg p-2.5 text-[13px] ${kind === "live" ? "border border-verified bg-verified-soft" : kind === "cur" ? "border border-dashed border-signal bg-signal-soft" : kind === "rej" ? "border border-dashed border-caution bg-caution-soft" : "bg-desk/60"}`}
    >
      <div className="break-all font-bold">{title}</div>
      <div className="text-ink-soft">{sub}</div>
    </div>
  );
  const arrow = (key: string, text: string) => <div key={key} className="pl-3 text-[12.5px] font-semibold text-ink-faint">↓ {text}</div>;
  const items: React.ReactNode[] = [node("base", lin.base, "COCO base · Apache-2.0")];
  lin.models.forEach((m, i) => {
    items.push(arrow(`a${i}`, i === 0 ? "fine-tuned on the first dataset (Colab)" : `fine-tuned on ${m.dataset ?? "a newer dataset"} (Kaggle)`));
    const serving = m.version === lin.serving;
    items.push(node(m.version, versionDate(m.version) ?? m.version, <>{m.test_map50 != null ? `test mAP@50 ${num4(m.test_map50)} · ` : ""}{serving ? <strong className="text-verified">serving now</strong> : m.source}</>, serving ? "live" : "plain"));
  });
  if (lin.current) {
    const c = lin.current;
    items.push(arrow("ac", `fine-tuned on ${c.dataset ?? "this dataset"} (Kaggle)`));
    const label = c.status === "rejected" ? "rejected by the gate · kept in S3" : c.status === "stopped" ? "stopped · not deployed" : c.status === "failed" ? "failed · not deployed" : "this run · deployed only if it passes the gate";
    items.push(node("cur", c.version ? versionDate(c.version) ?? c.version : "this run", label, c.status === "rejected" || c.status === "failed" || c.status === "stopped" ? "rej" : "cur"));
  }
  return (
    <Section title="Model lineage" id="lineage" aside="where each model comes from">
      <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto">{items}</div>
    </Section>
  );
}

// ---------------------------------------------------------------- evaluation and deployment decision
function OverfitCheck({ o, maxGap }: { o: Overfitting; maxGap: number }) {
  const gap = o.val_test_gap;
  const max = o.max_val_test_gap ?? maxGap;
  const passed = o.passed ?? (typeof gap === "number" ? gap <= max : true);
  return (
    <div className="mt-4 rounded-lg border border-desk-line p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[16px] font-bold">Overfitting check</h3>
        {passed ? <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> Generalises: gap within {max}</Pill> : <Pill tone="bad"><X className="h-3.5 w-3.5" aria-hidden /> Overfitting: not deployed</Pill>}
      </div>
      <p className="text-[13px] text-ink-faint">
        Loss at the chosen epoch {o.best_epoch ?? "?"}: training {num4(o.train_loss ?? undefined)}, validation {num4(o.val_loss ?? undefined)}
        {typeof o.loss_ratio === "number" ? ` (validation ÷ training ${o.loss_ratio.toFixed(2)})` : ""}
        {o.val_loss_rose_after_best ? ". Validation loss rose in later epochs, so an earlier checkpoint was kept." : "."} The decision uses the mAP gap, because training loss is measured on augmented images.
      </p>
    </div>
  );
}

function EvaluationCard({ state, run }: { state: PipelineState; run: Run | null }) {
  const data = run?.live?.data || {};
  const r = run?.result || data.result;
  const tm = data.test_metrics;
  const cal = data.calibration;
  const g = r?.gate;
  const champ = g?.baseline_test_metrics ?? undefined;
  const o = r?.overfitting;
  const cfg = state.config;
  const pending = <span className="text-ink-faint">pending</span>;
  const res = (ok?: boolean) => (r && g ? (ok ? <span className="font-bold text-verified">✓ pass</span> : <span className="font-bold text-fault">✕ fail</span>) : <span className="text-ink-faint">—</span>);
  const newMap = tm?.map_50 ?? r?.test_map50;
  const verdict = !run ? null : g ? (r?.status === "deployed" ? <Pill tone="good">✓ Deployed to “{r.deploy_alias || cfg.deploy_alias}”</Pill> : g.passed ? <Pill tone="warn">Passed, not deployed</Pill> : <Pill tone="bad">✕ Rejected, current model kept</Pill>) : run.status === "stopped" ? <Pill tone="bad">Stopped</Pill> : <Pill tone="plain">after training</Pill>;
  const rows: [React.ReactNode, React.ReactNode, React.ReactNode, React.ReactNode, React.ReactNode][] = [
    [<strong>Test mAP@50</strong>, num4(g?.baseline_test_map50 ?? undefined), newMap != null ? num4(newMap) : pending, `≥ ${g?.floor ?? cfg.gate_floor}`, res(newMap != null && newMap >= (g?.floor ?? cfg.gate_floor))],
    [<strong>Not worse than current</strong>, num4(g?.baseline_test_map50 ?? undefined), newMap != null ? num4(newMap) : pending, `drop ≤ ${g?.max_regression ?? cfg.gate_max_regression}`, res(g?.baseline_test_map50 == null || (newMap ?? 0) >= g.baseline_test_map50 - (g.max_regression ?? cfg.gate_max_regression))],
    [<strong>Overfitting (val − test)</strong>, "—", o ? `${num4(o.val_map50 ?? undefined)} − ${num4(o.test_map50 ?? undefined)} = ${num4(o.val_test_gap ?? undefined)}` : pending, `gap ≤ ${o?.max_val_test_gap ?? cfg.gate_max_val_test_gap ?? 0.05}`, res(o ? !!o.passed : undefined)],
    ["Test mAP@50:95", num4(champ?.map), tm?.map != null || r?.test_map != null ? num4(tm?.map ?? r?.test_map) : pending, <span className="text-ink-faint">info</span>, ""],
    ["Recall (mAR@100)", num4(champ?.mar_100), tm?.mar_100 != null ? num4(tm.mar_100) : pending, <span className="text-ink-faint">info</span>, ""],
    ["Precision / recall at threshold", "—", cal?.precision != null ? `${pct(cal.precision)} / ${pct(cal.recall)} @ ${cal.threshold}` : pending, <span className="text-ink-faint">info</span>, ""],
  ];
  return (
    <Section title="Evaluation and deployment decision" id="eval" aside={verdict}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] text-left text-[14px]">
          <thead className="text-[13px] text-ink-faint">
            <tr><th className="pb-2 font-normal">Check</th><th className="pb-2 font-normal">Current model</th><th className="pb-2 font-normal">New model</th><th className="pb-2 font-normal">Rule</th><th className="pb-2 font-normal">Result</th></tr>
          </thead>
          <tbody className="divide-y divide-desk">
            {rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j} className="py-2 pr-2 tnum">{cell}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
      {g && !g.passed && g.reasons?.length ? <p className="mt-3 rounded-lg bg-fault-soft px-3 py-2 text-[14px] text-fault"><strong>Why rejected:</strong> {g.reasons.join("; ")}</p> : null}
      {o ? <OverfitCheck o={o} maxGap={cfg.gate_max_val_test_gap ?? 0.05} /> : null}
      <p className="mt-3 text-[13px] text-ink-faint">Both models are scored on this run's test set, so the comparison is fair even when the dataset changed.</p>
    </Section>
  );
}

// ---------------------------------------------------------------- alerts + rollback
function Toggle({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-40 ${on ? "bg-ink" : "bg-desk-deep"}`}
    >
      <span className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-[left] ${on ? "left-[19px]" : "left-[3px]"}`} />
    </button>
  );
}

function AlertsCard({ state, admin }: { state: PipelineState; admin: ReturnType<typeof useAdmin> }) {
  const a = state.alerts;
  if (!a) return null;
  const rows: [keyof typeof a.prefs, string, boolean][] = [
    ["email", "Email me when a run finishes, fails or is stopped", a.channels.email],
    ["slack", "Slack / Discord message on deploy or failure", a.channels.slack],
    ["stuck", "Alert if a run is stuck (no heartbeat for 10 min)", a.channels.email || a.channels.slack],
    ["trigger", "Tell me what every dataset upload / webhook did (training started, same dataset skipped, blocked)", a.channels.email || a.channels.slack],
  ];
  return (
    <Section title="Alerts" id="alerts">
      <ul className="divide-y divide-desk">
        {rows.map(([k, label, available]) => (
          <li key={k} className="flex items-center justify-between gap-3 py-2.5">
            <span className={available ? "" : "text-ink-faint"}>
              {label}
              {!available && <span className="block text-[12px]">{k === "slack" ? "Set ALERT_WEBHOOK_URL in the server .env" : "Set SMTP_* and ALERT_EMAIL_TO in the server .env"}</span>}
            </span>
            <Toggle on={(a.prefs[k] ?? true) && available} label={label} disabled={!available || !state.config.admin_enabled} onChange={(v) => admin.request({ kind: "alerts", body: { [k]: v } })} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RollbackCard({ state, admin }: { state: PipelineState; admin: ReturnType<typeof useAdmin> }) {
  const target = state.rollback_to;
  const serving = state.lineage?.serving ?? state.serving?.alias?.version;
  const busy = state.run?.status === "deploying";
  return (
    <Section title="Roll back" id="rollback">
      <p className="text-[14px] text-ink-soft">Point the “{state.config.deploy_alias}” alias back to the previous model. Workers switch within {secs(state.config.model_poll_seconds ?? 300)}; nothing is deleted.</p>
      <dl className="my-3 grid gap-2">
        <div className="rounded-lg bg-desk/60 p-3"><dt className="text-[13px] text-ink-faint">Serving now</dt><dd className="break-all font-bold">{serving ? versionDate(serving) ?? serving : "—"}</dd></div>
        <div className="rounded-lg bg-desk/60 p-3"><dt className="text-[13px] text-ink-faint">Would switch to</dt><dd className="break-all font-bold">{target ? versionDate(target) ?? target : "no previous model recorded"}</dd></div>
      </dl>
      <button type="button" className="btn-quiet" disabled={!target || busy || !state.config.admin_enabled} onClick={() => admin.request({ kind: "rollback" })}>
        <RotateCcw className="h-4 w-4" aria-hidden /> Roll back the served model
      </button>
    </Section>
  );
}

function TrainingSettingsCard({ state, admin }: { state: PipelineState; admin: ReturnType<typeof useAdmin> }) {
  const t = state.training;
  const [epochs, setEpochs] = useState<number | null>(null);
  if (!t) return null;
  const value = epochs ?? t.epochs;
  const changed = value !== t.epochs;
  const can = state.config.admin_enabled;
  const est = secs(value * t.seconds_per_epoch);
  const running = state.run && isLive(state.run) ? state.run.live?.max_epochs ?? state.run.epochs : null;
  const step = (d: number) => setEpochs(Math.max(1, Math.min(t.max_epochs, value + d)));
  return (
    <Section title="Training epochs" id="epochs">
      <div className="flex items-center gap-3">
        <button type="button" className="btn-quiet h-10 w-10 justify-center p-0 text-[20px]" onClick={() => step(-1)} disabled={!can || value <= 1} aria-label="One epoch less">−</button>
        <output className="min-w-[64px] text-center font-display text-[32px] font-bold leading-none tnum" aria-live="polite">{value}</output>
        <button type="button" className="btn-quiet h-10 w-10 justify-center p-0 text-[20px]" onClick={() => step(1)} disabled={!can || value >= t.max_epochs} aria-label="One epoch more">+</button>
        <span className="text-[14px] text-ink-soft">max epochs<br /><span className="text-ink-faint">≈ {est} of training</span></span>
      </div>
      <p className="mt-3 text-[13px] text-ink-faint">
        {changed ? "Not saved yet. " : `Now: ${t.source}. `}Applies from the next run{running ? ` (the current run keeps ${running})` : ""}. Early stopping can still end training sooner if validation stops improving. Kaggle stops a notebook after 12 h.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="btn-primary" disabled={!can || !changed} onClick={() => admin.request({ kind: "settings", body: { epochs: value } })}>
          Save {value} epoch{value > 1 ? "s" : ""}
        </button>
        {t.source === "dashboard" && (
          <button type="button" className="btn-quiet" disabled={!can} onClick={() => { setEpochs(null); admin.request({ kind: "settings", body: { epochs: null } }); }}>
            Back to default ({t.env_epochs ?? t.mode_default})
          </button>
        )}
        {changed && <button type="button" className="btn-quiet" onClick={() => setEpochs(null)}>Cancel</button>}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- event log, decisions, history
function EventLog({ state, run, className = "", fill = true }: { state: PipelineState; run: Run | null; className?: string; fill?: boolean }) {
  const events = useMemo(() => {
    const evs = (run?.events ?? []).map((e) => ({ ts: e.ts, source: e.source, message: e.message, level: e.level }));
    const since = run ? Date.parse(run.created_at) - 60_000 : 0;
    // admin actions on this run are already in its events; the audit adds the ones that are not (e.g. alerts, roll back)
    const near = (ts: string) => evs.some((e) => e.source === "admin" && Math.abs(Date.parse(e.ts) - Date.parse(ts)) < 15_000);
    const audit = (state.audit ?? []).filter((a) => Date.parse(a.ts) >= since && !near(a.ts)).map((a) => ({ ts: a.ts, source: "admin", message: `${a.detail} (${a.who})`, level: "warning" as const }));
    return [...evs, ...audit].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }, [run?.events, state.audit, run]);
  const src = { kaggle: "text-[#8FE0B6]", admin: "text-[#FFD48A]", ec2: "text-[#9FB8FF]" } as Record<string, string>;
  return (
    <Section title="Event log" id="log" aside="EC2 + Kaggle + admin actions" className={className}>
      <Terminal
        fill={fill}
        height="max-h-[260px]"
        empty="No events yet."
        lines={events.map((e) => ({
          ts: e.ts,
          line: `${e.source.toUpperCase().padEnd(6, " ")} ${e.message}`,
          tone: e.level === "error" ? "text-[#FF9A9A]" : e.level === "warning" && e.source !== "admin" ? "text-[#FFD48A]" : src[e.source] ? "" : "",
        }))}
      />
    </Section>
  );
}

function Decisions({ state, className = "" }: { state: PipelineState; className?: string }) {
  const list = state.decisions.slice(0, 20);
  return (
    <Section title="Why runs started or not" id="decisions" className={className}>
      {list.length === 0 ? (
        <Empty>No triggers yet. Uploads, webhooks and button presses are listed here with the decision that was made.</Empty>
      ) : (
        <div className="relative min-h-[260px] flex-1">
          <ul className="absolute inset-0 divide-y divide-desk overflow-y-auto overscroll-contain pr-1" tabIndex={0} aria-label="Trigger decisions, scrolls">
            {list.map((d, i) => {
              const meta = DECISION[d.decision] ?? { label: d.decision, tone: "plain" as const };
              return (
                <li key={i} className="py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <Pill tone={meta.tone}>{meta.label}</Pill>
                    <span className="text-[13px] text-ink-faint tnum" title={d.ts}>{ago(d.ts)}</span>
                  </div>
                  <p className="mt-1 min-w-0 break-words text-[13.5px] text-ink-soft [overflow-wrap:anywhere]">{d.message}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

const TRIGGER_FILTERS: [string, string, (t: TriggerRecord) => boolean][] = [
  ["all", "All", () => true],
  ["started", "Training started", (t) => t.decision === "started"],
  ["skipped", "Skipped", (t) => ["skipped_trained", "skipped_failed", "no_dataset", "deferred"].includes(t.decision)],
  ["problems", "Problems", (t) => ["blocked", "error"].includes(t.decision)],
];

function TriggerHistory({ state, onSelect }: { state: PipelineState; onSelect: (id: string | null) => void }) {
  const [filter, setFilter] = useState("all");
  const all = state.triggers ?? [];
  const test = TRIGGER_FILTERS.find(([k]) => k === filter)?.[2] ?? (() => true);
  const list = all.filter(test);
  const runStatus = (id?: string | null) => state.runs.find((r) => r.id === id);
  return (
    <Section title="Trigger history" id="triggers" aside="every dataset upload, webhook and button press, and what it led to">
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Filter the trigger history">
        {TRIGGER_FILTERS.map(([k, label, f]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k}
            className={`rounded-full px-3 py-1 text-[13px] font-semibold transition-colors ${filter === k ? "bg-ink text-white" : "bg-desk text-ink-soft hover:bg-desk-deep"}`}>
            {label} <span className="tnum opacity-70">{all.filter(f).length}</span>
          </button>
        ))}
      </div>
      {list.length === 0 ? (
        <Empty>{all.length === 0 ? "No uploads yet. Each dataset upload (HF webhook), Check now and Retrain anyway is listed here with its outcome." : "Nothing in this filter."}</Empty>
      ) : (
        <div className="max-h-[420px] overflow-auto overscroll-contain" tabIndex={0} aria-label="Trigger history, scrolls">
          <table className="w-full min-w-[820px] text-left text-[14px]">
            <thead className="sticky top-0 bg-white text-[13px] text-ink-faint">
              <tr>
                <th className="pb-2 font-normal">When</th>
                <th className="pb-2 font-normal">Trigger</th>
                <th className="pb-2 font-normal">Dataset</th>
                <th className="pb-2 font-normal">Outcome</th>
                <th className="pb-2 font-normal">Details</th>
                <th className="pb-2 font-normal">Alert</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-desk">
              {list.map((t, i) => {
                const meta = DECISION[t.decision] ?? { label: t.decision, tone: "plain" as const };
                const run = runStatus(t.run_id);
                const runMeta = run ? RUN_STATUS[run.status] ?? { label: run.status, tone: "plain" as const } : null;
                return (
                  <tr key={`${t.ts}-${i}`} className="align-top">
                    <td className="py-2.5 pr-3 tnum whitespace-nowrap" title={t.ts}>
                      <div className="font-semibold">{new Date(t.ts).toLocaleDateString()} {clock(t.ts)}</div>
                      <div className="text-[12px] text-ink-faint">{ago(t.ts)}</div>
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">
                      <div>{TRIGGER_SOURCE[t.source ?? ""] ?? t.source ?? "—"}</div>
                      {t.hf_sha && <div className="text-[12px] text-ink-faint tnum" title={t.hf_sha}>commit {short(t.hf_sha, 8)}</div>}
                    </td>
                    <td className="min-w-[170px] max-w-[240px] py-2.5 pr-3">
                      <div className="break-words [overflow-wrap:anywhere]">{t.zip ?? "—"}</div>
                      {t.fingerprint && <div className="text-[12px] text-ink-faint tnum" title={t.fingerprint}>{short(t.fingerprint, 12)}</div>}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap"><Pill tone={meta.tone}>{meta.label}</Pill></td>
                    <td className="py-2.5 pr-3 text-[13.5px] text-ink-soft">
                      <p className="break-words [overflow-wrap:anywhere]">{t.message}</p>
                      {t.trained_version && <p className="mt-1 text-[12px] text-ink-faint">Trained before into {t.trained_version}{t.trained_status ? ` (gate: ${t.trained_status})` : ""}</p>}
                      {t.run_id && (
                        <button type="button" className="mt-1 inline-flex items-center gap-2 text-[13px] font-semibold text-signal underline underline-offset-4" onClick={() => onSelect(t.run_id ?? null)}>
                          Open run {t.run_id.replace("run-", "")}
                          {runMeta && <Pill tone={runMeta.tone}>{runMeta.label}</Pill>}
                        </button>
                      )}
                    </td>
                    <td className="py-2.5 text-[13px] whitespace-nowrap">
                      {t.alerts && t.alerts.length > 0
                        ? <span className="inline-flex items-center gap-1 text-verified"><Check className="h-3.5 w-3.5" aria-hidden />{t.alerts.map((a) => ({ slack: "Slack", email: "Email" })[a] ?? a).join(", ")}</span>
                        : <span className="text-ink-faint">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function Compare({ runs }: { runs: RunSummary[] }) {
  const [a, b] = runs;
  const rows: [string, (r: RunSummary) => React.ReactNode][] = [
    ["Outcome", (r) => (RUN_STATUS[r.status] ?? { label: r.status }).label],
    ["Dataset", (r) => r.zip ?? "—"],
    ["Dataset hash", (r) => short(r.fingerprint, 12)],
    ["Mode", (r) => r.mode ?? "—"],
    ["Epochs", (r) => r.epochs ?? "—"],
    ["Best validation mAP@50", (r) => num4(r.best_val_map50 ?? undefined)],
    ["Test mAP@50", (r) => num4(r.test_map50)],
    ["Test mAP@50:95", (r) => num4(r.test_map ?? undefined)],
    ["Overfit gap (val − test)", (r) => num4(r.val_test_gap ?? undefined)],
    ["Current model then", (r) => num4(r.champion_map50)],
    ["Threshold", (r) => r.threshold ?? "—"],
    ["Took", (r) => secs(r.duration_seconds)],
    ["Model version", (r) => (r.version ? versionDate(r.version) ?? r.version : "—")],
    ["Kaggle version", (r) => r.kaggle_version ?? "—"],
    ["Comet", (r) => (r.comet_url ? <a className="font-bold text-signal" href={r.comet_url} target="_blank" rel="noreferrer">open ↗</a> : "—")],
  ];
  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-desk-line">
      <table className="w-full min-w-[560px] text-left text-[14px]">
        <thead className="bg-desk/60 text-[13px]">
          <tr><th className="px-3 py-2 font-normal text-ink-faint">Compared</th><th className="px-3 py-2 tnum">{a.id.replace("run-", "")}</th><th className="px-3 py-2 tnum">{b.id.replace("run-", "")}</th></tr>
        </thead>
        <tbody className="divide-y divide-desk">
          {rows.map(([label, f]) => (
            <tr key={label}><td className="px-3 py-1.5 text-ink-faint">{label}</td><td className="px-3 py-1.5 tnum">{f(a)}</td><td className="px-3 py-1.5 tnum">{f(b)}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History({ state, selected, onSelect }: { state: PipelineState; selected?: string; onSelect: (id: string | null) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p.slice(-1), id]));
  const compare = picked.map((id) => state.runs.find((r) => r.id === id)).filter((r): r is RunSummary => !!r);
  return (
    <Section title="Run history" id="history" aside="click a run to inspect it · tick two to compare">
      {state.runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[14px]">
            <thead className="text-[13px] text-ink-faint">
              <tr>
                <th className="w-8 pb-2 font-normal"><span className="sr-only">Compare</span></th>
                <th className="pb-2 font-normal">Run</th>
                <th className="pb-2 font-normal">Outcome</th>
                <th className="pb-2 text-right font-normal">Test mAP@50</th>
                <th className="pb-2 text-right font-normal">Overfit gap</th>
                <th className="pb-2 pl-6 font-normal">Dataset</th>
                <th className="pb-2 text-right font-normal">Took</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-desk">
              {state.runs.map((r) => {
                const meta = RUN_STATUS[r.status] ?? { label: r.status, tone: "plain" as const };
                const isSel = selected === r.id;
                const open = () => onSelect(r.id === state.active_run_id ? null : r.id);
                return (
                  <tr key={r.id} className={`cursor-pointer align-top transition-colors ${isSel ? "bg-signal-soft" : "hover:bg-desk/60"}`} aria-selected={isSel}>
                    <td className="py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" className="h-4 w-4 accent-[#16245A]" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} aria-label={`Compare ${r.id}`} />
                    </td>
                    <td className="py-2.5 pr-3" tabIndex={0} onClick={open} onKeyDown={(e) => e.key === "Enter" && open()}>
                      <div className="font-bold tnum">{r.id.replace("run-", "")}</div>
                      <div className="text-[13px] text-ink-faint">{r.trigger}, {ago(r.created_at)}</div>
                    </td>
                    <td className="py-2.5 pr-3" onClick={open}>
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {r.version && <div className="mt-1 text-[12px] text-ink-faint" title={r.version}>{versionDate(r.version) ?? short(r.version, 24)}</div>}
                    </td>
                    <td className="py-2.5 text-right tnum" onClick={open}>
                      <div className="font-bold">{num4(r.test_map50)}</div>
                      {r.champion_map50 != null && <div className="text-[12px] text-ink-faint">current {num4(r.champion_map50)}</div>}
                    </td>
                    <td className={`py-2.5 text-right tnum ${(r.val_test_gap ?? 0) > (state.config.gate_max_val_test_gap ?? 0.05) ? "font-bold text-fault" : ""}`} onClick={open}>{num4(r.val_test_gap ?? undefined)}</td>
                    <td className="py-2.5 pl-6" onClick={open}>
                      <div className="break-words [overflow-wrap:anywhere]">{r.zip}</div>
                      <div className="text-[12px] text-ink-faint tnum">{short(r.fingerprint, 12)}</div>
                    </td>
                    <td className="py-2.5 text-right tnum text-ink-soft" onClick={open}>{secs(r.duration_seconds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {compare.length === 2 ? <Compare runs={compare} /> : picked.length === 1 ? <p className="mt-2 text-[13px] text-ink-faint">Tick one more run to compare.</p> : null}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- page
export default function PipelinePage() {
  const [pinned, setPinned] = useState<string | null>(null);
  const url = pinned ? `/v1/pipeline/state?run_id=${encodeURIComponent(pinned)}` : "/v1/pipeline/state";
  const { data: state, error, loading, reload } = usePolling<PipelineState>(url, 3000);
  const admin = useAdmin(() => reload());

  if (!state) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        {loading ? (
          <p className="text-ink-soft"><Loader2 className="mr-2 inline h-4 w-4 animate-spin" aria-hidden />Loading the pipeline state</p>
        ) : (
          <>
            <h1 className="text-[28px] font-bold">The pipeline state could not be loaded</h1>
            <p className="mt-2 text-ink-soft">{error} Check that Redis and the API are running; this page retries every few seconds.</p>
          </>
        )}
      </div>
    );
  }

  const run = state.run;
  const sv = state.serving || {};
  const served = sv.worker?.detector_version || sv.alias?.version;
  const viewingOld = pinned && pinned !== state.active_run_id;
  const q = state.kaggle_quota;
  const canStop = stoppable(state, run) && !viewingOld;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">Retraining pipeline</h1>
          <p className="max-w-[70ch] text-[17px] text-ink-soft">
            When a new dataset lands on Hugging Face, it is cleaned and trained on a Kaggle GPU, then deployed here only if it beats the current model.
          </p>
        </div>
        {state.config.admin_enabled && (
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-quiet" onClick={() => admin.request({ kind: "check" })} disabled={admin.busy}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Check for new data
            </button>
            <button type="button" className="btn-danger" onClick={() => admin.request({ kind: "force" })} disabled={admin.busy}>
              <Repeat className="h-4 w-4" aria-hidden /> Retrain anyway
            </button>
            <button
              type="button"
              className="btn bg-fault text-white hover:brightness-110"
              onClick={() => admin.request({ kind: "stop", runId: run?.id })}
              disabled={!canStop || admin.busy}
              title={canStop ? "Stop the running training" : "Available while a Kaggle run is training (before the gate)"}
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" aria-hidden /> Stop training
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-7 gap-y-2 text-[14px]">
        <span className="flex items-center gap-2" title={`Last heartbeat ${ago(state.orchestrator.last_heartbeat)}`}>
          <span className={`h-2.5 w-2.5 rounded-full ${state.orchestrator.online ? "bg-verified" : "bg-fault"}`} aria-hidden />
          <span className="font-bold">{state.orchestrator.online ? "Orchestrator online" : "Orchestrator offline"}</span>
        </span>
        <span title={served ?? ""}>
          <span className="text-ink-faint">Serving </span>
          <span className="font-bold">{served ? versionDate(served) ?? short(served, 28) : "unknown"}</span>
          {sv.alias_name && <span className="text-ink-faint"> through alias “{sv.alias_name}”</span>}
        </span>
        <span>
          <span className="text-ink-faint">Deploy rule </span>
          <span className="font-bold">
            mAP@50 ≥ {state.config.gate_floor}, at most {state.config.gate_max_regression} below current
            {state.config.gate_max_val_test_gap != null ? `, validation − test gap ≤ ${state.config.gate_max_val_test_gap}` : ""}
          </span>
        </span>
        {q && q.total_hours != null && (
          <span title={q.refresh_at ? `Quota resets ${new Date(q.refresh_at).toLocaleString()}` : undefined}>
            <span className="text-ink-faint">Kaggle GPU this week </span>
            <span className="font-bold tnum">{q.used_hours?.toFixed(1)} of {q.total_hours.toFixed(0)} h</span>
          </span>
        )}
        <span>
          <span className="text-ink-faint">Last webhook </span>
          <span className="font-bold">{state.last_webhook_at ? ago(state.last_webhook_at) : "none yet"}</span>
        </span>
        {state.pending_recheck && <Pill tone="live">A re-check is queued for after this run</Pill>}
        {error && <span className="text-caution">Live updates paused: {error}</span>}
      </div>

      {admin.message && !admin.pending && (
        <p role="status" className={`rounded-lg px-4 py-2 ${admin.message.tone === "good" ? "bg-verified-soft text-verified" : "bg-fault-soft text-fault"}`}>
          {admin.message.text}
        </p>
      )}

      {viewingOld && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-signal-soft px-4 py-2.5 text-signal">
          <span>You are looking at an earlier run.</span>
          <button type="button" className="font-bold underline underline-offset-4" onClick={() => setPinned(null)}>Back to the latest run</button>
        </div>
      )}

      <RunOverview state={state} run={run} />

      {run?.status === "failed" && (
        <section className="rounded-xl border border-fault/40 bg-fault-soft p-5">
          <h2 className="text-[20px] font-semibold text-fault">Why this run failed</h2>
          <p className="mt-1 text-fault">{run.error}</p>
          <p className="mt-1 text-[14px] text-ink-soft">The served model was not changed. Fix the cause, then use “Retrain anyway”, or upload a corrected dataset.</p>
          {run.log_tail && <pre className="mt-3 max-h-56 overflow-auto rounded-lg bg-ink p-3 font-code text-[12px] text-white/85">{run.log_tail}</pre>}
        </section>
      )}

      {/* Two columns that stack independently, so sections sit directly under each other. The last card of each
          column (Why runs started / Notebook output) stretches to the column height, so no gap is left at the end. */}
      <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="panel p-5" aria-labelledby="steps-title">
            <div className="mb-3 flex items-baseline justify-between"><h2 id="steps-title" className="text-[20px] font-semibold">Steps</h2><span className="text-[13px] text-ink-faint">time per step</span></div>
            <Steps phases={state.phases} run={run} eta={state.eta} />
          </section>
          <LineageCard state={state} />
          <ServingModelsCard state={state} admin={admin} />
          <TrainingSettingsCard state={state} admin={admin} />
          <AlertsCard state={state} admin={admin} />
          <RollbackCard state={state} admin={admin} />
          <Decisions state={state} className="flex-1" />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <DatasetCard state={state} run={run} />
            <CleaningCard run={run} />
          </div>
          <TrainingCard state={state} run={run} />
          <CometCard state={state} run={run} />
          <EvaluationCard state={state} run={run} />
          <NotebookOutput run={run} live={isLive(run)} fill className="flex-1" />
        </div>
      </div>

      <EventLog state={state} run={run} fill={false} />

      <TriggerHistory state={state} onSelect={setPinned} />

      <History state={state} selected={run?.id} onSelect={setPinned} />

      <ActionDialog admin={admin} />
    </div>
  );
}
