import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ExternalLink, Loader2, Minus, RefreshCw, Repeat, X } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { usePolling } from "../lib/hooks";
import { ago, bytes, clock, duration, int, num4, pct, short, versionDate } from "../lib/format";
import {
  DECISION,
  RUN_STATUS,
  TONE_PILL,
  type Gate,
  type Overfitting,
  type PhaseDef,
  type PipelineState,
  type Run,
  type RunResult,
} from "../lib/pipeline";

const INK = "#16245A";
const MARKER = "#D6245F";
const GRID = "#E6EAF0";

function Pill({ tone, children }: { tone: keyof typeof TONE_PILL; children: React.ReactNode }) {
  return <span className={`pill ${TONE_PILL[tone]}`}>{children}</span>;
}

function Section({ title, aside, children, id }: { title: string; aside?: React.ReactNode; children: React.ReactNode; id?: string }) {
  return (
    <section className="panel p-5" aria-labelledby={id}>
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

// ---------------------------------------------------------------- admin actions
function useAdmin() {
  const [open, setOpen] = useState<null | boolean>(null); // the pending action: force?
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (force: boolean, value: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/v1/pipeline/check?force=${force}`, { method: "POST", headers: { "X-Admin-Token": value } });
      if (res.status === 401) {
        sessionStorage.removeItem("pipelineAdminToken");
        setMessage({ tone: "bad", text: "That admin token is not correct. It is PIPELINE_ADMIN_TOKEN in the server's .env file." });
        setOpen(force);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sessionStorage.setItem("pipelineAdminToken", value);
      setMessage({ tone: "good", text: force ? "Retraining requested. The run appears below within a few seconds." : "Check requested. The decision appears below within a few seconds." });
      setOpen(null);
    } catch (e) {
      setMessage({ tone: "bad", text: `The request failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const request = (force: boolean) => {
    setMessage(null);
    const saved = sessionStorage.getItem("pipelineAdminToken");
    if (saved) send(force, saved);
    else {
      setToken("");
      setOpen(force);
    }
  };
  return { open, setOpen, token, setToken, message, busy, send, request };
}

function TokenDialog({ admin }: { admin: ReturnType<typeof useAdmin> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (admin.open !== null && !ref.current?.open) ref.current?.showModal();
    if (admin.open === null && ref.current?.open) ref.current?.close();
  }, [admin.open]);
  return (
    <dialog ref={ref} onClose={() => admin.setOpen(null)} className="w-[min(440px,92vw)] rounded-xl p-0 shadow-sheet backdrop:bg-ink/40">
      <form
        method="dialog"
        className="p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (admin.open !== null && admin.token) admin.send(admin.open, admin.token);
        }}
      >
        <h2 className="text-[22px] font-bold">{admin.open ? "Retrain the newest dataset" : "Check for a new dataset"}</h2>
        <p className="mt-1 text-ink-soft">
          {admin.open
            ? "This starts a Kaggle GPU run even if the newest dataset was already trained."
            : "This looks at the Hugging Face repo now instead of waiting for the webhook."}
        </p>
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
          <button type="button" className="btn-quiet" onClick={() => admin.setOpen(null)}>Cancel</button>
          <button type="submit" className={admin.open ? "btn-danger" : "btn-primary"} disabled={!admin.token || admin.busy}>
            {admin.open ? "Retrain anyway" : "Check now"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

// ---------------------------------------------------------------- run overview
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
          <Fact k="Training mode" v={state.config.mode === "full" ? "Full dataset" : "Smoke test (small)"} />
          <Fact k="GPU" v={state.config.accelerator.replace("Nvidia", "NVIDIA ")} />
          <Fact k="Deploys to alias" v={state.config.deploy_alias} />
        </dl>
      </section>
    );
  }

  const ph = run.phases;
  const current = phases.find((p) => ph[p.key]?.status === "running");
  const failed = phases.find((p) => ph[p.key]?.status === "failed");
  const done = phases.filter((p) => ["done", "skipped"].includes(ph[p.key]?.status)).length;
  const live = run.status === "running" || run.status === "deploying";
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: "plain" as const };
  const r = run.result || {};
  const L = run.live || {};
  const title = live ? current?.label ?? "Working" : failed ? `Stopped at: ${failed.label}` : status.label;
  const share = live ? done / phases.length : 1;

  return (
    <section className="panel p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Pill tone={status.tone}>
          {live && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          {status.label}
        </Pill>
        <span className="text-[14px] text-ink-faint">{run.id}</span>
      </div>
      <h2 className="mt-3 text-[30px] font-bold leading-tight">{title}</h2>
      <p className="mt-1 text-ink-soft">
        {live
          ? `Started by ${run.trigger.source} ${ago(run.created_at)} for ${run.dataset.zip}. Running for ${duration(run.created_at)}.`
          : `${run.dataset.zip} finished ${ago(run.finished_at)} after ${duration(run.created_at, run.finished_at)}.`}
      </p>

      <div className="mt-5">
        <div className="flex justify-between text-[14px]">
          <span className="font-bold">Progress</span>
          <span className="tnum text-ink-soft">{done} of {phases.length} steps</span>
        </div>
        <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-desk" role="progressbar" aria-valuenow={done} aria-valuemin={0} aria-valuemax={phases.length}>
          <div
            className={`h-full rounded-full transition-[width] duration-700 ${run.status === "failed" ? "bg-fault" : !live && run.status === "succeeded" ? "bg-verified" : live ? "bg-signal" : "bg-caution"}`}
            style={{ width: `${share * 100}%` }}
          />
        </div>
      </div>

      {live && (L.progress || []).filter((p) => p.total > 0).length > 0 && (
        <div className="mt-4 space-y-3">
          {(L.progress || [])
            .filter((p) => p.total > 0)
            .map((p) => {
              const eta = p.rate ? (p.total - p.n) / p.rate : null;
              return (
                <div key={p.desc}>
                  <div className="flex flex-wrap justify-between gap-2 text-[14px]">
                    <span>{p.desc}{p.postfix ? <span className="text-ink-faint"> ({p.postfix})</span> : null}</span>
                    <span className="tnum text-ink-soft">
                      {int(p.n)} / {int(p.total)}
                      {p.rate ? `, ${p.rate.toFixed(2)} it/s` : ""}
                      {eta != null ? `, about ${eta < 60 ? `${Math.round(eta)} s` : `${Math.round(eta / 60)} min`} left` : ""}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-desk">
                    <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, (p.n / p.total) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
        </div>
      )}

      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
        <Fact k="Trigger" v={`${run.trigger.source}${run.trigger.force ? " (forced)" : ""}`} />
        <Fact k="Mode" v={run.mode === "full" ? "Full dataset" : "Smoke test"} />
        <Fact k="Started from" v={run.served_before ? short(run.served_before, 26) : "Served model"} title={run.served_before ?? undefined} />
        <Fact k="Kaggle" v={run.kaggle.status ? `${run.kaggle.status}${run.kaggle.version ? `, version ${run.kaggle.version}` : ""}` : "—"} />
        {L.gpu?.name && <Fact k="GPU" v={`${L.gpu.name}${L.gpu.allocated_gb ? `, ${L.gpu.allocated_gb} GB used` : ""}`} />}
        {L.epochs?.length ? <Fact k="Epoch" v={`${L.epochs.length} of up to ${L.max_epochs ?? "?"}`} /> : null}
        {r.version && <Fact k="New model" v={versionDate(r.version) ?? short(r.version, 26)} title={r.version} />}
        {run.served_after && <Fact k="Now serving" v={versionDate(run.served_after) ?? short(run.served_after, 26)} title={run.served_after} />}
      </dl>
    </section>
  );
}

function Fact({ k, v, title }: { k: string; v: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-ink-faint">{k}</dt>
      <dd className="truncate font-bold" title={title}>{v}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- step timeline
function Steps({ phases, run }: { phases: PhaseDef[]; run: Run | null }) {
  let lastGroup = "";
  let n = 0;
  return (
    <ol className="space-y-0" aria-label="Pipeline steps">
      {phases.map((p, i) => {
        const st = run?.phases[p.key] ?? { status: "pending" as const };
        const group = p.where.includes("Kaggle") ? "kaggle" : "ec2";
        const header =
          group !== lastGroup ? (group === "kaggle" ? "On Kaggle (T4 GPU notebook)" : lastGroup ? "Back on EC2" : "On EC2 (orchestrator)") : null;
        lastGroup = group;
        n += 1;
        const time = st.status === "running" ? duration(st.started_at) : st.started_at && st.ended_at ? duration(st.started_at, st.ended_at) : "";
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
                        : st.status === "skipped"
                          ? "bg-desk text-ink-faint"
                          : "bg-paper text-ink-faint ring-1 ring-desk-line"
                }`}
                aria-label={st.status}
              >
                {st.status === "done" ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : st.status === "running" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : st.status === "failed" ? <X className="h-3.5 w-3.5" strokeWidth={3} /> : st.status === "skipped" ? <Minus className="h-3.5 w-3.5" /> : n}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className={`leading-snug ${st.status === "pending" || st.status === "skipped" ? "text-ink-faint" : st.status === "running" ? "font-bold" : ""}`}>{p.label}</span>
                  <span className="tnum shrink-0 text-[13px] text-ink-faint">{time}</span>
                </div>
                {st.detail && <p className={`mt-0.5 break-words text-[13px] ${st.status === "failed" ? "text-fault" : "text-ink-soft"}`}>{st.detail}</p>}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- dataset + cleaning
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
  return (
    <Section title="Dataset" id="ds" aside={<a className="inline-flex items-center gap-1 hover:text-ink" href={ds.url} target="_blank" rel="noreferrer">Open on Hugging Face <ExternalLink className="h-3.5 w-3.5" aria-hidden /></a>}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
        <dt className="text-ink-faint">File</dt>
        <dd className="break-all font-bold">{ds.zip} <span className="font-normal text-ink-faint">{bytes(ds.size_bytes)}</span></dd>
        <dt className="text-ink-faint">Uploaded</dt>
        <dd>{ds.committed_at ? new Date(ds.committed_at).toLocaleString() : "—"}{ds.commit_title ? <span className="text-ink-faint"> “{ds.commit_title}”</span> : null}</dd>
        <dt className="text-ink-faint">Content hash</dt>
        <dd className="tnum" title={ds.fingerprint}>SHA-256 {short(ds.fingerprint, 16)}</dd>
        <dt className="text-ink-faint">Integrity</dt>
        <dd>{nb?.sha256 ? (nb.sha256_verified ? <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> Verified on Kaggle</Pill> : <Pill tone="plain">Computed on Kaggle</Pill>) : <span className="text-ink-faint">Checked when Kaggle downloads the file</span>}</dd>
        {ds.other_zips?.length ? (
          <>
            <dt className="text-ink-faint">Older ZIPs</dt>
            <dd className="text-ink-soft">{ds.other_zips.join(", ")} (ignored, the newest ZIP is trained)</dd>
          </>
        ) : null}
      </dl>
    </Section>
  );
}

function CleaningCard({ run }: { run: Run | null }) {
  const s = run?.live?.data?.dataset_summary;
  if (!s) return <Section title="Data cleaning" id="clean"><Empty>The cleaning report appears once Kaggle has checked the dataset.</Empty></Section>;
  const fs = s.final_splits || {};
  const splits = (["train", "valid", "test"] as const).map((k) => ({ k, images: fs[k]?.images ?? 0, boxes: fs[k]?.boxes ?? 0 }));
  const total = splits.reduce((a, b) => a + b.images, 0) || 1;
  const invalid = (s.source_images ?? 0) - (s.valid_images ?? 0);
  const stats: [string, number | undefined, boolean][] = [
    ["Images in the ZIP", s.source_images, false],
    ["Unreadable or bad boxes", invalid, true],
    ["Exact duplicates removed", s.exact_removed, true],
    ["Train/test leaks removed", s.exact_cross_split_removed, true],
    ["Near-duplicate pairs", s.near_confirmed_pairs, true],
    ["Clean images", s.after_leakage_quarantine ?? s.after_exact_dedupe, false],
  ];
  const splitColor = { train: "bg-ink", valid: "bg-signal", test: "bg-marker" };
  return (
    <Section
      title="Data cleaning"
      id="clean"
      aside={s.leakage_gate_passed ? <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> No leakage between splits</Pill> : <Pill tone="bad">Leakage check failed</Pill>}
    >
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {stats.map(([label, v, flag]) => (
          <div key={label} className={`rounded-lg p-3 ${flag && (v ?? 0) > 0 ? "bg-caution-soft" : "bg-desk/60"}`}>
            <dd className="font-display text-[26px] font-bold leading-none tnum">{int(v)}</dd>
            <dt className="mt-1 text-[13px] text-ink-soft">{label}</dt>
          </div>
        ))}
      </dl>
      <div className="mt-5">
        <p className="field-label mb-1.5">Final split</p>
        <div className="flex h-8 overflow-hidden rounded-lg text-[13px] font-bold text-white" role="img" aria-label={splits.map((x) => `${x.k} ${x.images} images`).join(", ")}>
          {splits.map((x) => (
            <div key={x.k} className={`flex items-center px-2 ${splitColor[x.k]}`} style={{ flex: x.images || 0.0001 }} title={`${x.k}: ${x.images} images, ${x.boxes} boxes`}>
              <span className="truncate">{x.k} {int(x.images)}</span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[13px] text-ink-faint tnum">
          {splits.map((x) => `${x.k} ${Math.round((x.images / total) * 100)}%`).join(", ")}; {int(splits.reduce((a, b) => a + b.boxes, 0))} signature boxes in total
        </p>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- training + evaluation
function TrainingCard({ run }: { run: Run | null }) {
  const eps = run?.live?.epochs ?? [];
  const best = eps.length ? Math.max(...eps.map((e) => e.val_map50 ?? -1)) : null;
  const chart = (lines: { key: "train_loss" | "val_loss" | "val_map50"; name: string; color: string }[], domain?: [number, number]) => (
    <div className="h-[220px]">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={eps} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="epoch" tickFormatter={(v) => `${v}`} tick={{ fontSize: 12, fill: "#6B7493" }} tickLine={false} axisLine={{ stroke: "#C3CBD7" }} label={{ value: "epoch", position: "insideBottomRight", offset: -2, fontSize: 12, fill: "#6B7493" }} />
          <YAxis domain={domain ?? ["auto", "auto"]} tick={{ fontSize: 12, fill: "#6B7493" }} tickLine={false} axisLine={false} tickFormatter={(v: number) => v.toFixed(2)} width={48} />
          <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(4) : String(v))} labelFormatter={(l) => `Epoch ${l}`} contentStyle={{ borderRadius: 8, border: "1px solid #C3CBD7", fontSize: 13 }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 13 }} />
          {lines.map((l) => (
            <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2.5} dot={{ r: 3.5, strokeWidth: 0, fill: l.color }} activeDot={{ r: 5 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
  return (
    <Section title="Training" id="train" aside={eps.length ? `${eps.length} epoch${eps.length > 1 ? "s" : ""}, best validation mAP@50 ${num4(best)}` : undefined}>
      {eps.length === 0 ? (
        <Empty>Loss and accuracy curves appear after the first epoch. Every metric is also logged to Comet.</Empty>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h3 className="mb-1 text-[15px] font-bold">Loss (lower is better)</h3>
            {chart([{ key: "train_loss", name: "Training", color: INK }, { key: "val_loss", name: "Validation", color: MARKER }])}
          </div>
          <div>
            <h3 className="mb-1 text-[15px] font-bold">Validation mAP@50 (higher is better)</h3>
            {chart([{ key: "val_map50", name: "mAP@50", color: INK }], [0, 1])}
          </div>
        </div>
      )}
    </Section>
  );
}

function GateBars({ gate, result, cfg }: { gate: Gate; result: RunResult; cfg: PipelineState["config"] }) {
  const champ = gate.baseline_test_map50;
  const chal = result.test_map50;
  const floor = gate.floor ?? cfg.gate_floor;
  const maxDrop = gate.max_regression ?? cfg.gate_max_regression;
  const limit = typeof champ === "number" ? champ - maxDrop : null;
  const rows: [string, number | null | undefined, string][] = [
    ["Current model", champ, "bg-ink-faint"],
    ["New model", chal, gate.passed ? "bg-verified" : "bg-marker"],
  ];
  return (
    <div>
      <div className="relative space-y-3 pt-6">
        {typeof floor === "number" && (
          <div className="absolute bottom-0 top-0 z-10 border-l-2 border-dashed border-fault" style={{ left: `calc(132px + (100% - 200px) * ${floor})` }}>
            <span className="absolute -top-0.5 left-1.5 whitespace-nowrap text-[12px] font-bold text-fault tnum">minimum {floor}</span>
          </div>
        )}
        {limit != null && (
          <div className="absolute bottom-0 top-8 z-10 border-l-2 border-dotted border-ink-soft" style={{ left: `calc(132px + (100% - 200px) * ${Math.max(0, limit)})` }} title={`No more than ${maxDrop} below the current model`} />
        )}
        {rows.map(([name, v, color]) => (
          <div key={name} className="flex items-center gap-3">
            <span className="w-[120px] shrink-0 text-right text-[14px] text-ink-soft">{name}</span>
            <div className="relative h-5 flex-1 rounded bg-desk/60">
              {typeof v === "number" ? (
                <div className={`h-full rounded ${color}`} style={{ width: `${Math.max(1, v * 100)}%` }} />
              ) : (
                <span className="text-[13px] text-ink-faint">No served model to compare with</span>
              )}
            </div>
            <span className="w-14 shrink-0 text-right font-bold tnum">{typeof v === "number" ? v.toFixed(3) : ""}</span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-ink-faint">
        Test mAP@50, both models scored on this run's test set. To deploy, the new model needs at least {floor}, may be at most {maxDrop} below the current model (dotted line), and must pass the overfitting check below.
      </p>
    </div>
  );
}

function OverfitCheck({ o, maxGap }: { o: Overfitting; maxGap: number }) {
  const gap = o.val_test_gap;
  const max = o.max_val_test_gap ?? maxGap;
  const passed = o.passed ?? (typeof gap === "number" ? gap <= max : true);
  const ratio = o.loss_ratio;
  const rows: [string, string, string?][] = [
    ["Validation mAP@50", num4(o.val_map50 ?? undefined), `epoch ${o.best_epoch ?? "?"}, used to pick the checkpoint`],
    ["Test mAP@50", num4(o.test_map50 ?? undefined), "data the model never saw"],
    ["Gap (validation − test)", typeof gap === "number" ? gap.toFixed(4) : "—", `allowed up to ${max}`],
  ];
  return (
    <div className="mt-5 rounded-lg border border-desk-line p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[16px] font-bold">Overfitting check</h3>
        {passed ? (
          <Pill tone="good"><Check className="h-3.5 w-3.5" aria-hidden /> Generalises: gap within {max}</Pill>
        ) : (
          <Pill tone="bad"><X className="h-3.5 w-3.5" aria-hidden /> Overfitting: not deployed</Pill>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {rows.map(([label, v, hint]) => (
          <div key={label} className="rounded-lg bg-desk/60 p-3">
            <dd className="font-display text-[22px] font-bold leading-none tnum">{v}</dd>
            <dt className="mt-1 text-[13px] text-ink-soft">{label}</dt>
            {hint && <div className="text-[12px] text-ink-faint">{hint}</div>}
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[13px] text-ink-faint">
        Loss at the chosen epoch: training {num4(o.train_loss ?? undefined)}, validation {num4(o.val_loss ?? undefined)}
        {typeof ratio === "number" ? ` (validation ÷ training ${ratio.toFixed(2)})` : ""}
        {o.val_loss_rose_after_best ? ". Validation loss rose in later epochs, which is why an earlier checkpoint was kept." : "."}
        {" "}Shown for transparency; the deploy decision uses the mAP gap, because training loss is measured on augmented images.
      </p>
    </div>
  );
}

function EvaluationCard({ state, run }: { state: PipelineState; run: Run | null }) {
  const data = run?.live?.data || {};
  const r = run?.result || data.result;
  const tm = data.test_metrics;
  const cal = data.calibration;
  if (!tm && !r) return <Section title="Evaluation and deployment decision" id="eval"><Empty>The held-out test score and the deployment decision appear after training.</Empty></Section>;
  const verdict = r?.gate
    ? r.status === "deployed"
      ? { tone: "good" as const, text: `Deployed to “${r.deploy_alias || state.config.deploy_alias}”` }
      : r.gate.passed
        ? { tone: "warn" as const, text: "Passed, not deployed" }
        : { tone: "bad" as const, text: "Rejected, current model kept" }
    : null;
  const stats: [string, string][] = [
    ["Test mAP@50", num4(tm ? tm.map_50 : r?.test_map50)],
    ["Test mAP@50:95", num4(tm ? tm.map : r?.test_map)],
    ...(tm?.mar_100 != null ? [["Recall (mAR@100)", num4(tm.mar_100)] as [string, string]] : []),
    ["Detection threshold", cal?.threshold != null ? String(cal.threshold) : r?.recommended_threshold != null ? String(r.recommended_threshold) : "—"],
    ...(cal?.precision != null ? [["Precision / recall", `${pct(cal.precision)} / ${pct(cal.recall)}`] as [string, string]] : []),
  ];
  return (
    <Section title="Evaluation and deployment decision" id="eval" aside={verdict && <Pill tone={verdict.tone}>{verdict.text}</Pill>}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {stats.map(([label, v]) => (
          <div key={label} className="rounded-lg bg-desk/60 p-3">
            <dd className="font-display text-[24px] font-bold leading-none tnum">{v}</dd>
            <dt className="mt-1 text-[13px] text-ink-soft">{label}</dt>
          </div>
        ))}
      </dl>
      {r?.gate ? (
        <div className="mt-5">
          <GateBars gate={r.gate} result={r} cfg={state.config} />
          {!r.gate.passed && r.gate.reasons?.length ? <p className="mt-2 text-[14px] text-fault">{r.gate.reasons.join("; ")}</p> : null}
        </div>
      ) : null}
      {r?.overfitting ? <OverfitCheck o={r.overfitting} maxGap={state.config.gate_max_val_test_gap ?? 0.05} /> : null}
    </Section>
  );
}

// ---------------------------------------------------------------- log, links, tables
function EventLog({ run }: { run: Run | null }) {
  const box = useRef<HTMLDivElement>(null);
  const events = useMemo(() => [...(run?.events ?? [])].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)), [run?.events]);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events.length]);
  return (
    <Section title="Event log" id="log" aside={events.length ? `${events.length} events` : undefined}>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        className="max-h-[340px] overflow-y-auto rounded-lg bg-ink px-4 py-3 font-code text-[12.5px] leading-relaxed text-white/85"
        tabIndex={0}
        aria-label="Event log"
      >
        {events.length === 0 ? (
          <p className="text-white/60">No events yet.</p>
        ) : (
          events.map((e, i) => (
            <div key={i} className={`grid grid-cols-[64px_52px_1fr] gap-2 ${e.level === "error" ? "text-[#FF9A9A]" : e.level === "warning" ? "text-[#FFD48A]" : ""}`}>
              <span className="text-white/50">{clock(e.ts)}</span>
              <span className={e.source === "kaggle" ? "text-[#9FB8FF]" : "text-white/60"}>{e.source}</span>
              <span className="break-words">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </Section>
  );
}

function Links({ state, run }: { state: PipelineState; run: Run | null }) {
  const data = run?.live?.data || {};
  const r = run?.result || {};
  const s3 = r.s3_model_uri ? `https://s3.console.aws.amazon.com/s3/object/${r.s3_model_uri.replace("s3://", "").replace("/", "?prefix=")}` : null;
  const links: [string, string | null | undefined][] = [
    ["Hugging Face dataset", run ? run.dataset.url : state.config.hf_url],
    ["Kaggle notebook", run?.kaggle.url || state.config.kaggle_url],
    ["Comet experiment", data.comet_url || r.comet_url],
    ["Model version in S3", s3],
    ["API model info", "/v1/model"],
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {links.map(([label, href]) =>
        href ? (
          <a key={label} href={href} target="_blank" rel="noreferrer" className="btn-quiet px-3 py-1.5 text-[14px]">
            {label} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : (
          <span key={label} className="btn-quiet cursor-default px-3 py-1.5 text-[14px] opacity-45" title="Available once the run reaches this step">
            {label}
          </span>
        ),
      )}
    </div>
  );
}

function Decisions({ state }: { state: PipelineState }) {
  const list = state.decisions.slice(0, 14);
  return (
    <Section title="Why runs started or not" id="decisions">
      {list.length === 0 ? (
        <Empty>No triggers yet. Uploads, webhooks and button presses are listed here with the decision that was made.</Empty>
      ) : (
        <ul className="divide-y divide-desk">
          {list.map((d, i) => {
            const meta = DECISION[d.decision] ?? { label: d.decision, tone: "plain" as const };
            return (
              <li key={i} className="grid gap-x-4 gap-y-1 py-2.5 sm:grid-cols-[90px_150px_1fr]">
                <span className="text-[13px] text-ink-faint tnum" title={d.ts}>{ago(d.ts)}</span>
                <span><Pill tone={meta.tone}>{meta.label}</Pill></span>
                <span className="text-[14px] text-ink-soft">{d.message}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function History({ state, selected, onSelect }: { state: PipelineState; selected?: string; onSelect: (id: string | null) => void }) {
  return (
    <Section title="Run history" id="history" aside="Select a run to inspect it">
      {state.runs.length === 0 ? (
        <Empty>No runs yet.</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[14px]">
            <thead className="text-[13px] text-ink-faint">
              <tr>
                <th className="pb-2 font-normal">Run</th>
                <th className="pb-2 font-normal">Outcome</th>
                <th className="pb-2 text-right font-normal">Test mAP@50</th>
                <th className="pb-2 pl-6 font-normal">Dataset</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-desk">
              {state.runs.map((r) => {
                const meta = RUN_STATUS[r.status] ?? { label: r.status, tone: "plain" as const };
                const isSel = selected === r.id;
                return (
                  <tr
                    key={r.id}
                    tabIndex={0}
                    onClick={() => onSelect(r.id === state.active_run_id ? null : r.id)}
                    onKeyDown={(e) => e.key === "Enter" && onSelect(r.id === state.active_run_id ? null : r.id)}
                    className={`cursor-pointer align-top transition-colors ${isSel ? "bg-signal-soft" : "hover:bg-desk/60"}`}
                    aria-selected={isSel}
                  >
                    <td className="py-2.5 pr-3">
                      <div className="font-bold tnum">{r.id.replace("run-", "")}</div>
                      <div className="text-[13px] text-ink-faint">{r.trigger}, {ago(r.created_at)}</div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <Pill tone={meta.tone}>{meta.label}</Pill>
                      {r.version && <div className="mt-1 text-[12px] text-ink-faint" title={r.version}>{versionDate(r.version) ?? short(r.version, 24)}</div>}
                    </td>
                    <td className="py-2.5 text-right tnum">
                      <div className="font-bold">{num4(r.test_map50)}</div>
                      {r.champion_map50 != null && <div className="text-[12px] text-ink-faint">current {num4(r.champion_map50)}</div>}
                    </td>
                    <td className="py-2.5 pl-6">
                      <div className="break-words [overflow-wrap:anywhere]">{r.zip}</div>
                      <div className="text-[12px] text-ink-faint tnum">{short(r.fingerprint, 12)}</div>
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

// ---------------------------------------------------------------- page
export default function PipelinePage() {
  const [pinned, setPinned] = useState<string | null>(null);
  const url = pinned ? `/v1/pipeline/state?run_id=${encodeURIComponent(pinned)}` : "/v1/pipeline/state";
  const { data: state, error, loading } = usePolling<PipelineState>(url, 3000);
  const admin = useAdmin();

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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">Retraining pipeline</h1>
          <p className="max-w-[70ch] text-[17px] text-ink-soft">
            When a new dataset lands on Hugging Face, it is cleaned and trained on a Kaggle GPU, then deployed here only if it beats the current model.
          </p>
        </div>
        {state.config.admin_enabled && (
          <div className="flex gap-2">
            <button type="button" className="btn-quiet" onClick={() => admin.request(false)} disabled={admin.busy}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Check for new data
            </button>
            <button type="button" className="btn-danger" onClick={() => admin.request(true)} disabled={admin.busy}>
              <Repeat className="h-4 w-4" aria-hidden /> Retrain anyway
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-x-8 gap-y-2 text-[14px]">
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
        {state.pending_recheck && <Pill tone="live">A re-check is queued for after this run</Pill>}
        {error && <span className="text-caution">Live updates paused: {error}</span>}
      </div>

      {admin.message && admin.open === null && (
        <p role="status" className={`rounded-lg px-4 py-2 ${admin.message.tone === "good" ? "bg-verified-soft text-verified" : "bg-fault-soft text-fault"}`}>
          {admin.message.text}
        </p>
      )}

      {viewingOld && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-signal-soft px-4 py-2.5 text-signal">
          <span>You are looking at an earlier run.</span>
          <button type="button" className="font-bold underline underline-offset-4" onClick={() => setPinned(null)}>
            Back to the latest run
          </button>
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

      <div className="grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
        <section className="panel h-fit p-5" aria-labelledby="steps-title">
          <h2 id="steps-title" className="mb-3 text-[20px] font-semibold">Steps</h2>
          <Steps phases={state.phases} run={run} />
        </section>
        <div className="min-w-0 space-y-6">
          <DatasetCard state={state} run={run} />
          <CleaningCard run={run} />
          <TrainingCard run={run} />
          <EvaluationCard state={state} run={run} />
          <Links state={state} run={run} />
          <EventLog run={run} />
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <History state={state} selected={run?.id} onSelect={setPinned} />
        <Decisions state={state} />
      </div>

      <TokenDialog admin={admin} />
    </div>
  );
}
