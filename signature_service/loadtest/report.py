"""Turn a Locust step run (loadtest/locustfile.py) into the stress-test report: tables + charts in docs/.

  python loadtest/report.py --run loadtest/results/ec2_t3large \
      --instance "AWS EC2 t3.large (2 vCPU, 8 GB), ap-southeast-2" --workers "1 worker container, Celery concurrency 2"

Reads <run>_jobs.csv, <run>_system.csv, <run>_meta.json (written by the locustfile) and, if present,
cold_start_fresh.json / cold_start_warm.json in the same folder (scripts/measure_cold_start.py).
Writes docs/results/phase9_stress_test.md, docs/images/<run-name>_*.png and copies the raw files to
docs/results/stress_data/<run-name>/ (loadtest/results/ itself is not committed).

Per concurrency step the first WARMUP seconds are skipped, so each row describes the steady state.
"Stable" = no failed job and p95 end-to-end latency under --p95-target.
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import os
import shutil
import statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def pct(values: list[float], q: float) -> float | None:
    v = sorted(x for x in values if x is not None and not math.isnan(x))
    if not v:
        return None
    k = (len(v) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def num(x):
    try:
        f = float(x)
        return None if math.isnan(f) else f
    except (TypeError, ValueError):
        return None


def read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fmt_ms(x):
    if x is None:
        return "—"
    return f"{x / 1000:.2f} s" if x >= 1000 else f"{x:.0f} ms"


def fmt(x, d=1, suffix=""):
    return "—" if x is None else f"{x:.{d}f}{suffix}"


def stages(meta: dict, jobs: list[dict], warmup: float) -> list[dict]:
    steps = [int(s) for s in str(meta.get("steps", "")).split(",") if s.strip()]
    start = meta.get("started_at") or min(j["t_start"] for j in jobs)
    if steps:
        length = meta.get("step_seconds", 60)
        return [{"users": u, "from": start + i * length + warmup, "to": start + (i + 1) * length} for i, u in enumerate(steps)]
    out = []
    for u in sorted({j["users"] for j in jobs}):
        ts = [j["t_start"] for j in jobs if j["users"] == u]
        out.append({"users": u, "from": min(ts) + warmup, "to": max(j["t_end"] for j in jobs if j["users"] == u)})
    return out


def summarise(stage: dict, jobs: list[dict], system: list[dict]) -> dict:
    sel = [j for j in jobs if stage["from"] <= j["t_end"] < stage["to"] and j["t_start"] >= stage["from"] - 1]
    ok = [j for j in sel if j["ok"]]
    secs = max(1e-9, stage["to"] - stage["from"])
    e2e = [j["e2e_ms"] for j in ok]
    sysw = [s for s in system if stage["from"] <= s["t"] < stage["to"] and s.get("cpu_percent") is not None]
    def col(rows, k):
        return [r[k] for r in rows if r.get(k) is not None]
    return {
        "users": stage["users"], "jobs": len(sel), "ok": len(ok), "failed": len(sel) - len(ok),
        "failure_pct": (len(sel) - len(ok)) / len(sel) * 100 if sel else None,
        "throughput": len(ok) / secs, "p50": pct(e2e, .5), "p95": pct(e2e, .95), "p99": pct(e2e, .99),
        "mean": statistics.fmean(e2e) if e2e else None,
        "queue_p50": pct(col(ok, "queue_wait_ms"), .5), "queue_p95": pct(col(ok, "queue_wait_ms"), .95),
        "infer_p50": pct(col(ok, "inference_ms"), .5), "infer_p95": pct(col(ok, "inference_ms"), .95),
        "worker_procs": len({j["worker_pid"] for j in ok if j.get("worker_pid")}),
        "cpu_avg": statistics.fmean(col(sysw, "cpu_percent")) if sysw else None, "cpu_max": max(col(sysw, "cpu_percent"), default=None),
        "mem_avg": statistics.fmean(col(sysw, "mem_percent")) if sysw else None, "mem_max_mb": max(col(sysw, "mem_used_mb"), default=None),
        "mem_total_mb": max(col(sysw, "mem_total_mb"), default=None),
        "queue_len_avg": statistics.fmean(col(sysw, "queue_length")) if col(sysw, "queue_length") else None,
        "queue_len_max": max(col(sysw, "queue_length"), default=None),
        "errors": sorted({str(j.get("error") or j.get("http_status")) for j in sel if not j["ok"]})[:3],
    }


def charts(rows: list[dict], jobs: list[dict], meta: dict, out_dir: Path, name: str) -> dict[str, str]:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    INK, MARKER, SIGNAL, OK, WARN = "#16245A", "#D6245F", "#2F5BD3", "#11815A", "#B26B00"
    plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True,
                         "grid.color": "#E6EAF0", "axes.edgecolor": "#C3CBD7", "axes.titleweight": "bold", "axes.titlesize": 11})
    out_dir.mkdir(parents=True, exist_ok=True)
    users = [r["users"] for r in rows]
    files = {}

    def save(fig, key):
        for ax in fig.axes:
            if ax.get_xlabel() == "concurrent users":
                ax.set_xticks(users)
        path = out_dir / f"{name}_{key}.png"
        fig.tight_layout()
        fig.savefig(path, dpi=140)
        plt.close(fig)
        files[key] = path

    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    for k, c, label in (("p50", INK, "p50"), ("p95", MARKER, "p95"), ("p99", WARN, "p99")):
        ax.plot(users, [(r[k] or 0) / 1000 for r in rows], "o-", color=c, label=label, lw=2)
    ax.set(title="End-to-end latency per job", xlabel="concurrent users", ylabel="seconds")
    ax.legend(frameon=False)
    save(fig, "latency")

    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    ax.plot(users, [r["throughput"] for r in rows], "o-", color=INK, lw=2, label="completed images/s")
    for r in rows:
        if r["failed"]:
            ax.annotate(f"{r['failure_pct']:.0f}% failed", (r["users"], r["throughput"]), textcoords="offset points", xytext=(0, 8), ha="center", color=MARKER, fontsize=9)
    ax.set(title="Throughput", xlabel="concurrent users", ylabel="images per second")
    ax.set_ylim(bottom=0)
    save(fig, "throughput")

    fig, ax = plt.subplots(figsize=(6.4, 3.6))
    ax.plot(users, [(r["queue_p50"] or 0) / 1000 for r in rows], "o-", color=SIGNAL, lw=2, label="queue wait p50")
    ax.plot(users, [(r["queue_p95"] or 0) / 1000 for r in rows], "o--", color=SIGNAL, lw=1.5, label="queue wait p95")
    ax.plot(users, [(r["infer_p50"] or 0) / 1000 for r in rows], "o-", color=OK, lw=2, label="inference p50")
    ax.set(title="Where the time goes", xlabel="concurrent users", ylabel="seconds")
    ax.legend(frameon=False)
    save(fig, "breakdown")

    if any(r["cpu_avg"] is not None for r in rows):
        fig, ax = plt.subplots(figsize=(6.4, 3.6))
        ax.plot(users, [r["cpu_avg"] or 0 for r in rows], "o-", color=MARKER, lw=2, label="CPU % (avg)")
        ax.plot(users, [r["cpu_max"] or 0 for r in rows], "o--", color=MARKER, lw=1.2, label="CPU % (max)")
        ax.plot(users, [r["mem_avg"] or 0 for r in rows], "o-", color=INK, lw=2, label="RAM %")
        ax.set(title="Server resources (whole EC2 host)", xlabel="concurrent users", ylabel="percent", ylim=(0, 105))
        ax.legend(frameon=False)
        save(fig, "resources")

    t0 = meta.get("started_at") or min(j["t_start"] for j in jobs)
    fig, ax = plt.subplots(figsize=(10, 3.4))
    okj = [j for j in jobs if j["ok"]]
    bad = [j for j in jobs if not j["ok"]]
    ax.scatter([(j["t_end"] - t0) / 60 for j in okj], [j["e2e_ms"] / 1000 for j in okj], s=6, color=INK, alpha=.5, label="job finished")
    if bad:
        ax.scatter([(j["t_end"] - t0) / 60 for j in bad], [j["e2e_ms"] / 1000 for j in bad], s=14, color=MARKER, marker="x", label="job failed")
    ax2 = ax.twinx()
    ts = sorted(jobs, key=lambda j: j["t_start"])
    ax2.step([(j["t_start"] - t0) / 60 for j in ts], [j["users"] for j in ts], where="post", color=WARN, lw=1.5, label="users")
    ax2.set_ylabel("users", color=WARN)
    ax2.yaxis.get_major_locator().set_params(integer=True)
    ax2.grid(False)
    ax.set(title="Every job over the whole test", xlabel="minutes since start", ylabel="end-to-end seconds")
    ax.legend(frameon=False, loc="upper left")
    save(fig, "timeline")
    return {k: str(v) for k, v in files.items()}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True, help="results prefix, e.g. loadtest/results/ec2_t3large")
    ap.add_argument("--instance", default="AWS EC2 t3.large (2 vCPU, 8 GB RAM), ap-southeast-2 (Sydney)")
    ap.add_argument("--workers", default="1 inference worker container, Celery prefork concurrency 2, TORCH_THREADS 1")
    ap.add_argument("--client", default="Locust on a laptop in Pakistan (upload time includes the internet path to Sydney)")
    ap.add_argument("--p95-target", type=float, default=10_000, help="ms; a step is stable if p95 is below this and nothing failed")
    ap.add_argument("--warmup", type=float, default=15)
    ap.add_argument("--out", default=str(REPO / "docs" / "results" / "phase9_stress_test.md"))
    args = ap.parse_args()

    run = Path(args.run)
    name = run.name
    meta = json.loads(Path(f"{run}_meta.json").read_text()) if Path(f"{run}_meta.json").exists() else {}
    jobs = []
    for j in read_csv(Path(f"{run}_jobs.csv")):
        jobs.append({**j, "t_start": float(j["t_start"]), "t_end": float(j["t_end"]), "users": int(j["users"] or 0),
                     "ok": j["ok"] == "True", "e2e_ms": float(j["e2e_ms"]), "queue_wait_ms": num(j.get("queue_wait_ms")),
                     "inference_ms": num(j.get("inference_ms")), "worker_ms": num(j.get("worker_ms"))})
    if not jobs:
        raise SystemExit(f"no jobs in {run}_jobs.csv: run the locustfile first")
    system = [{**s, "t": float(s["t"]), **{k: num(s.get(k)) for k in ("cpu_percent", "mem_percent", "mem_used_mb", "mem_total_mb", "queue_length", "load_avg_1m")}}
              for s in read_csv(Path(f"{run}_system.csv"))]
    rows = [summarise(s, jobs, system) for s in stages(meta, jobs, args.warmup)]
    rows = [r for r in rows if r["jobs"]]
    out = Path(args.out)
    images = charts(rows, jobs, meta, out.parent.parent / "images", name)

    stable = [r for r in rows if r["failed"] == 0 and r["p95"] is not None and r["p95"] <= args.p95_target]
    max_stable = max((r["users"] for r in stable), default=None)
    peak = max(rows, key=lambda r: r["throughput"])
    infer = rows[0]["infer_p50"]  # uncontended model time: lowest-load step
    procs = max((r["worker_procs"] for r in rows), default=0)
    theory = procs / (infer / 1000) if infer and procs else None
    cold = {k: json.loads(p.read_text()) for k in ("fresh", "warm") if (p := run.parent / f"cold_start_{k}.json").exists()}
    total_jobs, total_failed = len(jobs), sum(1 for j in jobs if not j["ok"])
    duration_min = ((meta.get("ended_at") or max(j["t_end"] for j in jobs)) - (meta.get("started_at") or min(j["t_start"] for j in jobs))) / 60

    rel = lambda p: Path(os.path.relpath(Path(p).resolve(), out.resolve().parent)).as_posix()  # noqa: E731
    L = []
    L.append("# Phase 9: stress test and cold start\n")
    L.append(f"Measured {dt.datetime.fromtimestamp(meta.get('started_at', jobs[0]['t_start'])).strftime('%Y-%m-%d %H:%M')} "
             f"against `{meta.get('host', '?')}`. Generated by `signature_service/loadtest/report.py` from the raw Locust files.\n")
    L.append("| Setup | |\n|---|---|")
    L.append(f"| Server | {args.instance} |\n| Inference workers | {args.workers} |\n| Load generator | {args.client} |")
    L.append(f"| Test images | {meta.get('images', '?')} {'real test-split documents' if meta.get('real_images') else 'synthetic A4 pages'} |")
    L.append(f"| Load shape | {meta.get('steps') or 'manual'} concurrent users, {meta.get('step_seconds', '?')} s per step, first {args.warmup:.0f} s of each step not counted |")
    L.append(f"| User behaviour | upload a document, wait for the result (queue + worker), pause {meta.get('think_seconds', [0.5, 1.5])[0]}–{meta.get('think_seconds', [0.5, 1.5])[1]} s, repeat |")
    L.append(f"| Total | {total_jobs:,} jobs in {duration_min:.1f} min, {total_failed} failed |\n")

    L.append("## Results per concurrency step\n")
    L.append("| Users | Jobs | Failed | Images/s | p50 | p95 | p99 | Queue wait p50 / p95 | Inference p50 | Jobs waiting (avg / max) | CPU avg / max | RAM max |")
    L.append("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        L.append(f"| {r['users']} | {r['jobs']} | {r['failed']} ({fmt(r['failure_pct'], 0, '%')}) | {r['throughput']:.2f} | {fmt_ms(r['p50'])} | {fmt_ms(r['p95'])} | "
                 f"{fmt_ms(r['p99'])} | {fmt_ms(r['queue_p50'])} / {fmt_ms(r['queue_p95'])} | {fmt_ms(r['infer_p50'])} | "
                 f"{fmt(r['queue_len_avg'], 1)} / {fmt(r['queue_len_max'], 0)} | {fmt(r['cpu_avg'], 0, '%')} / {fmt(r['cpu_max'], 0, '%')} | "
                 f"{fmt((r['mem_max_mb'] or 0) / 1000, 2, ' GB') if r['mem_max_mb'] else '—'} |")
    L.append("")
    L.append("Latency = end-to-end per job as the user sees it: upload, waiting in the Redis queue, model on a Celery worker, result back. "
             "Queue wait and inference are measured by the worker and returned with every result.\n")

    L.append("## What the numbers say\n")
    L.append(f"* **Maximum stable concurrency: {max_stable if max_stable is not None else 'none of the tested steps'} users** "
             f"(no failed job and p95 under {args.p95_target / 1000:.0f} s).")
    L.append(f"* **Peak throughput: {peak['throughput']:.2f} images/s** at {peak['users']} users "
             f"({peak['throughput'] * 3600:,.0f} images per hour, {peak['throughput'] * 86400:,.0f} per day).")
    if theory:
        L.append(f"* Capacity check: {procs} worker processes ÷ {infer / 1000:.2f} s per image ≈ **{theory:.2f} images/s** theoretical; "
                 f"measured {peak['throughput']:.2f} ({peak['throughput'] / theory * 100:.0f}% of it). More users than worker processes only adds queue wait.")
    last = rows[-1]
    if last["queue_p50"] is not None and rows[0]["queue_p50"] is not None:
        first_inf, last_inf = rows[0]["infer_p50"], last["infer_p50"]
        same = first_inf and last_inf and last_inf / first_inf < 1.3
        L.append(f"* Queue wait grows from {fmt_ms(rows[0]['queue_p50'])} at {rows[0]['users']} user(s) to {fmt_ms(last['queue_p50'])} at {last['users']} users. "
                 + (f"Inference stays ≈ {fmt_ms(last_inf)}: extra load turns into waiting in the queue, the model itself does not slow down."
                    if same else f"Inference also slows from {fmt_ms(first_inf)} to {fmt_ms(last_inf)} because the worker processes compete for the same CPU cores."))
    if last["cpu_avg"] is not None:
        L.append(f"* At {last['users']} users the host CPU averages {last['cpu_avg']:.0f}%: "
                 + ("CPU-bound, so more vCPUs (bigger instance) or more worker hosts raise capacity." if last["cpu_avg"] > 80 else "CPU still has headroom; raise WORKER_CONCURRENCY or add worker containers."))
    fails = [r for r in rows if r["failed"]]
    if fails:
        L.append(f"* Failures appear from {fails[0]['users']} users: {', '.join(fails[0]['errors']) or 'see the Locust report'}.")
    else:
        L.append("* **No job failed at any step**: under overload, jobs wait in Redis instead of being dropped.")
    L.append("* Scaling: `docker compose up -d --scale worker=N` (one host) or more EC2/ECS worker hosts on the same Redis; "
             "throughput grows with worker processes until the CPU is full.\n")

    L.append("## Charts\n")
    for key, title in (("latency", "Latency"), ("throughput", "Throughput"), ("breakdown", "Queue wait vs inference"), ("resources", "CPU and RAM"), ("timeline", "Timeline")):
        if key in images:
            L.append(f"![{title}]({rel(images[key])})\n")

    L.append("## Cold start\n")
    if cold:
        L.append("| Mode | Container start → ready | Model load in worker (S3 fetch + SHA-256 + load + warm-up) | First request | Warm request (median of 5) |")
        L.append("|---|---:|---:|---:|---:|")
        for k in ("fresh", "warm"):
            if k in cold:
                c = cold[k]
                L.append(f"| {c.get('mode', k)} | {fmt(c.get('container_to_ready_s'), 1, ' s')} | {fmt(c.get('in_worker_model_load_s'), 1, ' s')} | "
                         f"{fmt_ms(c.get('first_request_ms'))} | {fmt_ms(c.get('warm_request_ms_median'))} |")
        L.append("\n*Fresh* deletes the cached model first, so it includes downloading the model from S3. *Warm* restarts the worker with the model already cached on the volume. "
                 "Requests that arrive during a cold start wait in Redis and are processed once the worker is ready.\n")
    else:
        L.append("Not measured in this run. On the EC2 host: `python3 scripts/measure_cold_start.py --fresh` and `python3 scripts/measure_cold_start.py`, "
                 "then copy `loadtest/results/cold_start_*.json` next to the run files and run this report again.\n")

    # loadtest/results/ is git-ignored (scratch); the evidence for this report is copied next to it
    data = out.parent / "stress_data" / name
    data.mkdir(parents=True, exist_ok=True)
    copied = []
    for f in sorted(run.parent.glob(f"{name}*")) + sorted(run.parent.glob("cold_start_*.json")):
        if f.is_file() and f.suffix in {".csv", ".html", ".json"}:
            shutil.copy2(f, data / f.name)
            copied.append(f.name)
    L.append("## Raw data and how to repeat\n")
    L.append(f"Files in [`{rel(data)}/`]({rel(data)}/):\n")
    for f in copied:
        what = ("Locust HTML report (open in a browser)" if f.endswith(".html") else "one row per job (users, end-to-end, queue wait, inference, worker)" if f.endswith("_jobs.csv")
                else "host CPU, RAM, load and jobs waiting, every 2 s" if f.endswith("_system.csv") else "Locust per-endpoint statistics" if f.endswith("_stats.csv")
                else "Locust statistics over time" if f.endswith("_stats_history.csv") else "Locust failures" if f.endswith("_failures.csv")
                else "cold start measurement" if f.startswith("cold_start") else "run settings" if f.endswith("_meta.json") else "")
        L.append(f"* `{f}`{': ' + what if what else ''}")
    L.append("\nCommands: see the header of `signature_service/loadtest/locustfile.py` and of `report.py`.")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(L) + "\n", encoding="utf-8")
    print(f"report: {out}")
    for r in rows:
        print(f"  users {r['users']:>3}: {r['throughput']:.2f} img/s, p95 {fmt_ms(r['p95'])}, failed {r['failed']}, queue p50 {fmt_ms(r['queue_p50'])}, cpu {fmt(r['cpu_avg'], 0, '%')}")
    print(f"  max stable concurrency: {max_stable}, peak {peak['throughput']:.2f} img/s")


if __name__ == "__main__":
    main()
