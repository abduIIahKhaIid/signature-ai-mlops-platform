"""EC2 retraining orchestrator: continuous training without storing any dataset in AWS.

    HF webhook / schedule / dashboard button
        -> is there a dataset ZIP in the HF repo?               (no ZIP  -> nothing to do)
        -> has THIS dataset (content SHA-256) been trained?      (yes     -> skip, never retrain the same data)
        -> build the Kaggle job (notebook pinned to the exact commit + file + SHA-256) and push it to a T4 GPU
        -> follow it: Kaggle status + the notebook's live-progress JSON in S3 (phases, epochs, progress bars)
        -> collect the result (validation gate decision)
        -> wait until the EC2 inference workers hot-reload the new model (if the gate deployed it)

Everything the dashboard shows lives in Redis (`pipeline:*` keys); the S3 dataset markers
(`<prefix>/pipeline_runs/datasets/<sha256>.json`, written by the notebook) are the durable "already trained" record.
The dataset itself only ever travels Hugging Face -> Kaggle.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import types
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger("signature.pipeline")

# (key, label, where it runs). The dashboard draws exactly this list; notebook phases use the same keys.
PHASES = [
    ("trigger", "Trigger received", "EC2"),
    ("dataset_check", "Dataset ZIP present in Hugging Face repo", "EC2"),
    ("dedup", "New dataset? (content SHA-256 vs trained datasets)", "EC2"),
    ("kaggle_submit", "Job submitted to Kaggle", "EC2 → Kaggle"),
    ("kaggle_start", "Kaggle T4 GPU allocated, notebook started", "Kaggle"),
    ("download", "Download pinned dataset ZIP + verify SHA-256", "Kaggle"),
    ("parse", "Read annotations (YOLO / COCO)", "Kaggle"),
    ("clean", "Clean: invalid images, bad boxes, exact duplicates", "Kaggle"),
    ("near_dup", "Near-duplicate screening (pHash + SSIM)", "Kaggle"),
    ("split", "Leakage gate + train / val / test split", "Kaggle"),
    ("warm_start", "Load served model from S3 (fine-tune start)", "Kaggle"),
    ("training", "Fine-tune RT-DETRv2 (Comet tracking)", "Kaggle"),
    ("evaluation", "Held-out test evaluation", "Kaggle"),
    ("calibration", "Threshold calibration (validation set)", "Kaggle"),
    ("package", "Package versioned model", "Kaggle"),
    ("publish", "Upload immutable version to S3", "Kaggle → S3"),
    ("gate", "Validation gate: challenger vs champion", "Kaggle"),
    ("collect", "Collect results", "EC2"),
    ("hot_reload", "EC2 workers serving the new model", "EC2"),
]
PHASE_KEYS = [p[0] for p in PHASES]
NOTEBOOK_PHASES = PHASE_KEYS[PHASE_KEYS.index("download"):PHASE_KEYS.index("gate") + 1]
ACTIVE_KAGGLE = {"queued", "running", "new", "pending"}
TERMINAL_KAGGLE_ERRORS = {"error", "cancelacknowledged", "cancelrequested", "cancelled", "canceled", "failed"}


def utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def json_safe(x):
    """NaN / inf are not valid JSON: the dashboard API would fail with a 500. Replace them with None."""
    if isinstance(x, float):
        return x if math.isfinite(x) else None
    if isinstance(x, dict):
        return {k: json_safe(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [json_safe(v) for v in x]
    return x


def _size(n: int) -> str:
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:.1f} MB"


def _fmt(x) -> str:
    return f"{x:.4f}" if isinstance(x, (int, float)) else "n/a"


def _parse_ts(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ===================================================================== state in Redis
class PipelineStore:
    def __init__(self, redis_client):
        self.r = redis_client

    def _get(self, key: str):
        raw = self.r.get(key)
        return json.loads(raw) if raw else None

    def _set(self, key: str, value, ex: int | None = None) -> None:
        self.r.set(key, json.dumps(json_safe(value), default=str), ex=ex)

    # runs
    def get_run(self, run_id: str) -> dict | None:
        return self._get(f"pipeline:run:{run_id}")

    def save_run(self, run: dict) -> None:
        run["updated_at"] = utcnow()
        self._set(f"pipeline:run:{run['id']}", run, ex=90 * 24 * 3600)

    def add_run(self, run: dict) -> None:
        self.save_run(run)
        self.r.lpush("pipeline:runs", run["id"])
        self.r.ltrim("pipeline:runs", 0, 49)

    def run_ids(self, limit: int = 20) -> list[str]:
        return [x.decode() if isinstance(x, bytes) else x for x in self.r.lrange("pipeline:runs", 0, limit - 1)]

    # one active run at a time
    def active(self) -> str | None:
        v = self.r.get("pipeline:active")
        return v.decode() if isinstance(v, bytes) else v

    def claim_active(self, run_id: str) -> bool:
        return bool(self.r.set("pipeline:active", run_id, nx=True))

    def release_active(self, run_id: str) -> None:
        if self.active() == run_id:
            self.r.delete("pipeline:active")

    # trigger decisions (transparency: why a run did or did not start)
    def decide(self, decision: str, message: str, **extra) -> dict:
        entry = {"ts": utcnow(), "decision": decision, "message": message, **extra}
        self.r.lpush("pipeline:decisions", json.dumps(json_safe(entry), default=str))
        self.r.ltrim("pipeline:decisions", 0, 99)
        log.info("pipeline decision %s: %s", decision, message)
        return entry

    def decisions(self, limit: int = 30) -> list[dict]:
        return [json.loads(x) for x in self.r.lrange("pipeline:decisions", 0, limit - 1)]

    # misc
    def get_json(self, key: str):
        return self._get(f"pipeline:{key}")

    def set_json(self, key: str, value, ex: int | None = None) -> None:
        self._set(f"pipeline:{key}", value, ex)

    def failures(self, fingerprint: str) -> int:
        return int(self.r.get(f"pipeline:failures:{fingerprint}") or 0)

    def add_failure(self, fingerprint: str) -> None:
        self.r.incr(f"pipeline:failures:{fingerprint}")
        self.r.expire(f"pipeline:failures:{fingerprint}", 30 * 24 * 3600)

    def clear_failures(self, fingerprint: str) -> None:
        self.r.delete(f"pipeline:failures:{fingerprint}")

    def set_pending(self) -> None:
        self.r.set("pipeline:pending", 1)

    def pop_pending(self) -> bool:
        return bool(self.r.delete("pipeline:pending"))

    def claim_webhook_window(self, seconds: int) -> bool:
        return bool(self.r.set("pipeline:webhook_window", 1, nx=True, ex=max(1, seconds)))

    # admin actions (stop, rollback, buttons, alert settings): shown in the event log
    def audit(self, action: str, detail: str, who: str = "dashboard") -> dict:
        entry = {"ts": utcnow(), "action": action, "detail": detail, "who": who}
        self.r.lpush("pipeline:audit", json.dumps(entry))
        self.r.ltrim("pipeline:audit", 0, 99)
        return entry

    def audit_log(self, limit: int = 30) -> list[dict]:
        return [json.loads(x) for x in self.r.lrange("pipeline:audit", 0, limit - 1)]

    # stop requests are kept apart from the run record, so the worker's save cannot overwrite them
    def request_stop(self, run_id: str, who: str) -> None:
        self._set(f"pipeline:stop:{run_id}", {"at": utcnow(), "by": who}, ex=7 * 24 * 3600)

    def stop_request(self, run_id: str) -> dict | None:
        return self._get(f"pipeline:stop:{run_id}")

    def heartbeat(self) -> None:
        self.r.set("pipeline:heartbeat", time.time())

    def last_heartbeat(self) -> float | None:
        v = self.r.get("pipeline:heartbeat")
        return float(v) if v else None


# ===================================================================== run record helpers
def new_run(trigger: dict, dataset: dict, mode: str) -> dict:
    now = utcnow()
    run_id = f"run-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{secrets.token_hex(2)}"
    return {
        "id": run_id, "status": "running", "created_at": now, "updated_at": now, "finished_at": None,
        "mode": mode, "trigger": trigger, "dataset": dataset,
        "kaggle": {"kernel": None, "url": None, "version": None, "status": None, "message": None,
                   "pushed_at": None, "seen_active": False},
        "phases": {k: {"status": "pending"} for k in PHASE_KEYS},
        "events": [], "live": None, "live_events_seen": 0, "result": None, "error": None, "log_tail": None,
        "served_before": None, "served_after": None,
    }


def event(run: dict, message: str, level: str = "info", source: str = "ec2", ts: str | None = None) -> None:
    run["events"].append({"ts": ts or utcnow(), "level": level, "source": source, "message": message})
    run["events"] = run["events"][-400:]
    getattr(log, "warning" if level in {"warning", "error"} else "info")("[%s] %s", run["id"], message)


def set_phase(run: dict, key: str, status: str, detail: str | None = None) -> None:
    phase = run["phases"][key]
    now = utcnow()
    if status == "running" and phase.get("status") != "running":
        phase["started_at"] = now
    if status in {"done", "failed", "skipped", "stopped"}:
        phase.setdefault("started_at", now)
        phase["ended_at"] = now
    phase["status"] = status
    if detail is not None:
        phase["detail"] = detail


def run_summary(run: dict) -> dict:
    result = run.get("result") or {}
    over = result.get("overfitting") or {}
    start, end = _parse_ts(run.get("created_at")), _parse_ts(run.get("finished_at"))
    return {
        "mode": run.get("mode"), "best_val_map50": result.get("best_val_map50"), "val_test_gap": over.get("val_test_gap"),
        "epochs": result.get("epochs_completed"), "duration_seconds": (end - start) if (start and end) else None,
        "kaggle_version": (run.get("kaggle") or {}).get("version"), "comet_url": result.get("comet_url"),
        "test_map": result.get("test_map"), "threshold": result.get("recommended_threshold"),
        "id": run["id"], "status": run["status"], "created_at": run["created_at"], "finished_at": run.get("finished_at"),
        "trigger": (run.get("trigger") or {}).get("source"), "zip": (run.get("dataset") or {}).get("zip"),
        "fingerprint": (run.get("dataset") or {}).get("fingerprint"), "version": result.get("version"),
        "gate_status": result.get("status"), "test_map50": result.get("test_map50"),
        "champion_map50": (result.get("gate") or {}).get("baseline_test_map50"), "error": run.get("error"),
    }


# ===================================================================== Hugging Face (metadata only, no download)
class HfInspector:
    def __init__(self, token: str | None):
        self.token = token

    def inspect(self, repo: str, revision: str = "main") -> dict:
        from huggingface_hub import HfApi

        api = HfApi(token=self.token)
        info = api.repo_info(repo, repo_type="dataset", revision=revision)
        files = list(api.list_repo_tree(repo, repo_type="dataset", revision=info.sha, recursive=True, expand=True))
        zips = []
        for f in files:
            path = str(getattr(f, "path", ""))
            if not path.lower().endswith(".zip") or getattr(f, "size", None) is None:
                continue
            lfs = getattr(f, "lfs", None)
            sha = (lfs.get("sha256") if isinstance(lfs, dict) else getattr(lfs, "sha256", None)) if lfs else None
            last = getattr(f, "last_commit", None)
            date = getattr(last, "date", None)
            blob = getattr(f, "blob_id", None)
            zips.append({"path": path, "size": int(f.size), "sha256": sha, "blob_id": blob,
                         "committed_at": date.isoformat() if date else None,
                         "commit_title": getattr(last, "title", None),
                         "fingerprint": sha or (f"git-{blob}" if blob else None)})
        # same rule as the notebook: the most recently committed ZIP is the dataset to train on
        zips.sort(key=lambda z: (z["committed_at"] or "", z["path"]), reverse=True)
        return {"repo": repo, "commit": info.sha, "zips": zips, "files": len(files),
                "url": f"https://huggingface.co/datasets/{repo}/tree/{info.sha}"}


# ===================================================================== Kaggle CLI
class KaggleCLI:
    def __init__(self, username: str | None, kernel_slug: str, secrets_slug: str, accelerator: str):
        self.username = username
        self.kernel = f"{username}/{kernel_slug}" if username else None
        self.secrets_dataset = f"{username}/{secrets_slug}" if username else None
        self.accelerator = accelerator

    @property
    def url(self) -> str | None:
        return f"https://www.kaggle.com/code/{self.kernel}" if self.kernel else None

    def _run(self, *args: str, timeout: int = 120) -> subprocess.CompletedProcess:
        return subprocess.run(["kaggle", *args], capture_output=True, text=True, timeout=timeout)

    def problems(self) -> list[str]:
        out = []
        if not self.username:
            out.append("KAGGLE_USERNAME is not set in .env")
        if not (os.environ.get("KAGGLE_KEY") or os.environ.get("KAGGLE_API_TOKEN")):
            out.append("KAGGLE_KEY (or KAGGLE_API_TOKEN) is not set in .env")
        if shutil.which("kaggle") is None:
            out.append("kaggle CLI is not installed in the pipeline container")
        return out

    def secrets_ready(self) -> tuple[bool, str]:
        r = self._run("datasets", "status", self.secrets_dataset, timeout=60)
        text = (r.stdout + r.stderr).strip()
        return r.returncode == 0 and "ready" in text.lower(), text[-300:]

    def push(self, build_dir: Path) -> dict:
        r = self._run("kernels", "push", "-p", str(build_dir), "--accelerator", self.accelerator, timeout=300)
        text = (r.stdout + r.stderr).strip()
        if r.returncode != 0 or "error" in text.lower():
            raise RuntimeError(f"kaggle kernels push failed: {text[-500:]}")
        m = re.search(r"version\s+(\d+)", text, re.I)
        return {"version": int(m.group(1)) if m else None, "output": text[-500:]}

    def status(self) -> tuple[str, str | None]:
        r = self._run("kernels", "status", self.kernel, timeout=60)
        text = (r.stdout + r.stderr).strip()
        m = re.search(r'has status "([^"]+)"', text)
        if not m:
            raise RuntimeError(f"could not read Kaggle status: {text[-300:]}")
        state = m.group(1).split(".")[-1].strip().lower()
        msg = re.search(r'Failure message: "(.*)"', text)
        return state, (msg.group(1) if msg else None)

    def logs(self, max_lines: int = 60) -> str:
        r = self._run("kernels", "logs", self.kernel, timeout=120)
        text = r.stdout or r.stderr or ""
        try:  # notebook logs are a JSON list of {stream_name, time, data}
            text = "".join(item.get("data", "") for item in json.loads(text))
        except Exception:
            pass
        return "\n".join(text.strip().splitlines()[-max_lines:])

    def quota(self) -> dict | None:
        """Weekly GPU quota from `kaggle quota -v` (CSV: resource,used,remaining,total,refreshAt)."""
        r = self._run("quota", "-v", timeout=60)
        for line in (r.stdout or "").splitlines():
            cells = [c.strip() for c in line.split(",")]
            if cells and cells[0].upper() == "GPU" and len(cells) >= 4:
                hours = lambda v: float(v.rstrip("h") or 0)  # noqa: E731
                return {"used_hours": hours(cells[1]), "remaining_hours": hours(cells[2]), "total_hours": hours(cells[3]),
                        "refresh_at": cells[4] if len(cells) > 4 else None}
        return None

    def output(self, dest: Path) -> list[str]:
        dest.mkdir(parents=True, exist_ok=True)
        r = self._run("kernels", "output", self.kernel, "-p", str(dest), "--force", timeout=300)
        if r.returncode != 0:
            raise RuntimeError((r.stdout + r.stderr)[-300:])
        return [str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()]


# ===================================================================== orchestrator
# ===================================================================== trigger alert texts
TRIGGER_TITLES = {
    "started": "Training started",
    "skipped_trained": "Dataset already trained, no training started",
    "skipped_failed": "Dataset failed before, not retried automatically",
    "no_dataset": "No dataset ZIP in the Hugging Face repo",
    "deferred": "Training is busy, the dataset will be checked afterwards",
    "blocked": "Retraining is blocked",
    "error": "Dataset check failed",
}
TRIGGER_SOURCES = {"webhook": "Hugging Face webhook", "manual": "dashboard button", "schedule": "scheduled check",
                   "pending": "re-check after the previous run"}
TRIGGER_NEXT = {
    "started": "Kaggle is training now. You get another message when the run ends (deployed, rejected, failed or stopped).",
    "skipped_trained": "No GPU time was used. To train on new data, upload a ZIP with different content (the file name "
                       "does not matter, the SHA-256 of the content does). To train on this one again anyway: "
                       "dashboard -> Retrain anyway.",
    "skipped_failed": "Fix the cause shown in the dashboard, then press Retrain anyway.",
    "no_dataset": "Upload a reviewed dataset ZIP to the Hugging Face repo.",
    "deferred": "Nothing to do: the check runs by itself when the current run ends.",
    "blocked": "Nothing was started. Fix the setting above (server .env / Secrets Manager), then press Check now.",
    "error": "Nothing was started. It is retried by the next webhook, the next scheduled check, or Check now.",
}


def trigger_text(entry: dict, cfg) -> str:
    when = entry.get("ts") or utcnow()
    lines = [f"What happened: {entry.get('message')}", "",
             f"Trigger: {TRIGGER_SOURCES.get(entry.get('source'), entry.get('source'))} at {when}"]
    if entry.get("hf_sha"):
        lines.append(f"Hugging Face commit: {str(entry['hf_sha'])[:12]}")
    if entry.get("zip"):
        lines.append(f"Dataset ZIP: {entry['zip']}")
    if entry.get("fingerprint"):
        lines.append(f"Content SHA-256: {str(entry['fingerprint'])[:16]}...")
    marker = entry.get("marker") or {}
    if marker:
        lines.append(f"Trained before: model {marker.get('version')} on {str(marker.get('trained_at_utc', '?'))[:16]} "
                     f"(gate: {marker.get('status')})")
    if entry.get("run_id"):
        lines.append(f"Run: {entry['run_id']}")
    lines += ["", TRIGGER_NEXT.get(entry.get("decision"), "")]
    if cfg.public_url:
        lines.append(f"Dashboard: {cfg.public_url.rstrip('/')}/pipeline")
    return "\n".join(line for line in lines if line is not None)


class Orchestrator:
    def __init__(self, settings, store: PipelineStore, s3, hf: HfInspector, kaggle: KaggleCLI,
                 probe: Callable[[], dict | None], clock: Callable[[], float] = time.time, comet=None, notifier=None):
        self.comet = comet          # CometClient or None (no COMET_API_KEY on the server)
        self.notifier = notifier    # alerts.Notifier or None
        self.cfg = settings
        self.store = store
        self.s3 = s3
        self.hf = hf
        self.kaggle = kaggle
        self.probe = probe
        self.clock = clock
        self.prefix = settings.model_s3_prefix.strip("/")
        self.bucket = settings.model_s3_bucket
        self.alias = settings.model_alias or "latest"

    # ---------------------------------------------------------------- S3 (metadata only)
    def _s3_json(self, key: str) -> dict | None:
        try:
            return json.loads(self.s3.get_object(Bucket=self.bucket, Key=key)["Body"].read())
        except Exception as exc:
            code = getattr(exc, "response", {}).get("Error", {}).get("Code")
            if code in {"NoSuchKey", "404", "NotFound"}:
                return None
            raise

    def trained_marker(self, fingerprint: str) -> dict | None:
        return self._s3_json(f"{self.prefix}/pipeline_runs/datasets/{fingerprint}.json")

    def live_progress(self, run_id: str) -> dict | None:
        try:
            return self._s3_json(f"{self.prefix}/pipeline_runs/live/{run_id}.json")
        except Exception as exc:
            log.warning("cannot read live progress for %s: %s", run_id, exc)
            return None

    # ---------------------------------------------------------------- trigger handling
    def request_check(self, source: str, hf_sha: str | None = None, force: bool = False, note: str | None = None) -> dict:
        repo = self.cfg.hf_dataset_repo
        if not repo:
            return self._decide("blocked", "HF_DATASET_REPO is not set on the server", source=source)
        active = self.store.active()
        if active:
            self.store.set_pending()
            return self._decide("deferred", f"run {active} is in progress; the dataset will be re-checked "
                                                 "as soon as it finishes", source=source, hf_sha=hf_sha, run_id=active)
        try:
            repo_state = self.hf.inspect(repo)
        except Exception as exc:
            return self._decide("error", f"could not read Hugging Face repo {repo}: {exc}", source=source)
        self.store.set_json("last_check", {"ts": utcnow(), "source": source, "commit": repo_state["commit"],
                                           "zips": repo_state["zips"][:5], "url": repo_state["url"]})
        base = {"source": source, "hf_sha": repo_state["commit"]}
        if not repo_state["zips"]:
            return self._decide("no_dataset", f"no .zip dataset in {repo}@{repo_state['commit'][:8]}: nothing to "
                                                   "train. Upload a reviewed dataset ZIP to start training.", **base)
        newest = repo_state["zips"][0]
        fp = newest["fingerprint"]
        base.update(zip=newest["path"], fingerprint=fp)
        try:
            marker = self.trained_marker(fp)
        except Exception as exc:  # unknown -> do NOT start (a duplicate GPU run is worse than waiting)
            return self._decide("error", f"cannot read the trained-dataset record in S3: {exc}", **base)
        if marker and not force:
            return self._decide(
                "skipped_trained",
                f"{newest['path']} has the same content (SHA-256 {fp[:12]}…) as a dataset already trained in model "
                f"{marker.get('version')} (gate: {marker.get('status')}); not retraining", marker=marker, **base)
        fails = self.store.failures(fp)
        if fails >= self.cfg.pipeline_max_auto_attempts and not force and source != "manual":
            return self._decide("skipped_failed", f"{newest['path']} failed {fails} times; not retrying "
                                                       "automatically. Use 'Retrain now' on the dashboard.", **base)
        problems = self.kaggle.problems()
        if problems:
            return self._decide("blocked", "Kaggle is not configured: " + "; ".join(problems), **base)
        comet_problem = self.comet_preflight()
        if comet_problem:
            return self._decide("blocked", comet_problem, **base)
        if not self.secrets_sync_values():
            ready, text = self.kaggle.secrets_ready()
            if not ready:
                return self._decide("blocked", f"Kaggle secrets dataset {self.kaggle.secrets_dataset} is not ready "
                                                    f"({text}). See docs/setup/retraining_pipeline.md, step 'Kaggle secrets'.", **base)

        dataset = {"repo": repo, "commit": repo_state["commit"], "url": repo_state["url"], "zip": newest["path"],
                   "size_bytes": newest["size"], "sha256": newest["sha256"], "fingerprint": fp,
                   "committed_at": newest["committed_at"], "commit_title": newest["commit_title"],
                   "other_zips": [z["path"] for z in repo_state["zips"][1:]]}
        run = new_run({"source": source, "hf_sha": hf_sha, "force": force, "note": note, "received_at": utcnow()},
                      dataset, self.cfg.retrain_mode)
        if not self.store.claim_active(run["id"]):
            self.store.set_pending()
            return self._decide("deferred", "another run started at the same moment; re-checking later", **base)
        try:
            serving = self.probe()
            run["served_before"] = serving.get("detector_version") if serving else None
        except Exception:
            pass
        set_phase(run, "trigger", "done", f"{source}" + (f" · HF commit {hf_sha[:8]}" if hf_sha else ""))
        set_phase(run, "dataset_check", "done", f"{newest['path']} · {_size(newest['size'])} · commit "
                                                f"{repo_state['commit'][:8]}")
        set_phase(run, "dedup", "done", "forced retrain (dataset already trained)" if (marker and force)
                  else f"new dataset · SHA-256 {fp[:12]}…")
        event(run, f"{source} trigger: new dataset {newest['path']} ({_size(newest['size'])}) at HF commit "
                   f"{repo_state['commit'][:8]}; fine-tuning from the served model {run['served_before'] or '(unknown)'}")
        self.store.add_run(run)
        self._decide("started", f"run {run['id']} started for {newest['path']}", run_id=run["id"], **base)
        self._submit(run)
        self.store.save_run(run)
        return {"decision": "started", "run_id": run["id"]}

    # ---------------------------------------------------------------- trigger alerts
    # Every check that a person caused (HF webhook, dashboard button, the re-check after a run) ends in one decision,
    # and that decision is sent to the alert channels: "training started", "same dataset, nothing started", "blocked
    # because ...". So nobody has to open the server or the dashboard to learn what an upload did.
    # The fallback poll (source "schedule") runs every few minutes: it only reports a start, and the same blocked /
    # error message at most once every TRIGGER_REPEAT_SECONDS, so a lasting problem cannot flood the inbox.
    TRIGGER_REPEAT_SECONDS = 6 * 3600

    def _decide(self, decision: str, message: str, **extra) -> dict:
        entry = self.store.decide(decision, message, **extra)
        try:
            self.trigger_alert(entry)
        except Exception as exc:  # an alert must never change what the pipeline does
            log.warning("trigger alert failed: %s", exc)
        return entry

    def trigger_alert(self, entry: dict) -> list[str]:
        decision, source = entry.get("decision"), entry.get("source") or "?"
        if not self.notifier or decision not in TRIGGER_TITLES:
            return []
        if source == "schedule":
            if decision in ("blocked", "error"):
                digest = hashlib.sha1(f"{decision}|{entry.get('message')}".encode()).hexdigest()[:16]
                if not self.store.r.set(f"pipeline:trigger_alerted:{digest}", 1, nx=True, ex=self.TRIGGER_REPEAT_SECONDS):
                    return []
            elif decision != "started":
                return []
        subject = TRIGGER_TITLES[decision] + (f": {entry['zip']}" if entry.get("zip") else "")
        return self.notifier.send("trigger", subject, trigger_text(entry, self.cfg))

    # ---------------------------------------------------------------- Comet + secrets
    def comet_preflight(self) -> str | None:
        """With COMET_API_KEY on EC2: check key + workspace before any GPU time is spent (None = OK)."""
        if not self.comet:
            return None
        try:
            workspaces = self.comet.workspaces()
        except Exception as exc:
            return f"Comet rejected COMET_API_KEY from the server .env ({exc}); fix it before training"
        ws = self.cfg.comet_workspace
        if ws and ws not in workspaces:
            return f"Comet workspace '{ws}' does not belong to this COMET_API_KEY (its workspaces: {', '.join(workspaces) or 'none'})"
        return None

    def comet_workspace_setting(self) -> str | None:
        """COMET_WORKSPACE from .env, unless it is obviously the project name (a common mix-up): then None, so the
        notebook uses the API key's own workspace instead of failing the GPU run."""
        ws = self.cfg.comet_workspace
        return None if ws and ws == self.cfg.comet_project else ws

    def secrets_sync_values(self) -> dict | None:
        """Secrets for the Kaggle notebook, when the .env has all of them (else the existing dataset is used)."""
        c = self.cfg
        values = {"COMET_API_KEY": c.comet_api_key, "COMET_WORKSPACE": self.comet_workspace_setting(), "HF_TOKEN": c.hf_token,
                  "AWS_ACCESS_KEY_ID": c.notebook_aws_access_key_id, "AWS_SECRET_ACCESS_KEY": c.notebook_aws_secret_access_key,
                  "AWS_REGION": c.notebook_aws_region, "AWS_S3_BUCKET": c.model_s3_bucket}
        if not all(values[k] for k in ("COMET_API_KEY", "HF_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                                       "AWS_REGION", "AWS_S3_BUCKET")):
            return None
        return {k: v for k, v in values.items() if v}

    def _submit(self, run: dict) -> None:
        set_phase(run, "kaggle_submit", "running")
        ds = run["dataset"]
        try:
            sys.path.insert(0, self.cfg.pipeline_dir)
            import kaggle_job

            values = self.secrets_sync_values()
            if values:
                kaggle_job.push_secrets(self.kaggle.secrets_dataset, values, wait_seconds=300)
                event(run, f"Kaggle secrets synced from the server .env ({', '.join(sorted(values))})")

            if self.cfg.comet_workspace and self.comet_workspace_setting() is None:
                event(run, f"COMET_WORKSPACE in .env is the project name '{self.cfg.comet_workspace}'; ignored, the notebook "
                           "uses the Comet API key's own workspace. Set COMET_WORKSPACE=<your Comet workspace> in .env.", "warning")
            run["epochs"] = training_settings(self.store, self.cfg, run["mode"])["epochs"]
            build = Path(self.cfg.pipeline_work_dir) / run["id"] / "kaggle"
            kaggle_job.cmd_build(types.SimpleNamespace(
                kernel=self.kaggle.kernel, mode=run["mode"], epochs=run["epochs"], hf_repo=ds["repo"], hf_zip=ds["zip"],
                hf_revision=ds["commit"], secrets_dataset=self.kaggle.secrets_dataset, deploy_alias=self.alias,
                no_deploy=False, gate_floor=self.cfg.gate_min_test_map50, gate_max_regression=self.cfg.gate_max_regression,
                gate_max_val_test_gap=self.cfg.gate_max_val_test_gap, comet_project=self.cfg.comet_project,
                comet_workspace=self.comet_workspace_setting(),
                github_run_url=None, run_id=run["id"], dataset_fingerprint=ds["fingerprint"],
                expected_sha256=ds["sha256"], out=str(build)))
            pushed = self.kaggle.push(build)
        except Exception as exc:
            self._fail(run, f"could not submit the Kaggle job: {exc}", fetch_logs=False)
            return
        run["kaggle"].update(kernel=self.kaggle.kernel, url=self.kaggle.url, version=pushed.get("version"),
                             pushed_at=utcnow(), status="submitted")
        set_phase(run, "kaggle_submit", "done", f"{self.kaggle.kernel} v{pushed.get('version') or '?'} · "
                                                f"{self.kaggle.accelerator} · mode {run['mode']}")
        set_phase(run, "kaggle_start", "running", "waiting for a Kaggle GPU")
        event(run, f"Kaggle job pushed: {self.kaggle.kernel} version {pushed.get('version')} on {self.kaggle.accelerator}")

    # ---------------------------------------------------------------- periodic tick (beat, every few seconds)
    def tick(self) -> None:
        self.store.heartbeat()
        active = self.store.active()
        if active:
            run = self.store.get_run(active)
            if run is None or run["status"] not in {"running", "deploying"}:
                self.store.release_active(active)
            else:
                try:
                    if run["status"] == "running":
                        self.monitor(run)
                    else:
                        self.check_reload(run)
                except Exception as exc:  # never let one bad poll kill the orchestrator
                    event(run, f"monitor error (will retry): {exc!r}", "warning")
                self.store.save_run(run)
                if run["status"] not in {"running", "deploying"}:
                    self.store.release_active(run["id"])
        else:
            last = self.store.get_json("last_poll") or 0
            if self.store.pop_pending():
                self.request_check("pending", note="re-check after the previous run")
            elif self.cfg.pipeline_poll_minutes and self.clock() - last >= self.cfg.pipeline_poll_minutes * 60:
                self.store.set_json("last_poll", self.clock())
                self.request_check("schedule", note=f"fallback poll every {self.cfg.pipeline_poll_minutes} min")
        self.refresh_serving()
        self.refresh_quota()

    def refresh_quota(self) -> None:
        cached = self.store.get_json("kaggle_quota") or {}
        if self.clock() - cached.get("checked_epoch", 0) < 600 or not hasattr(self.kaggle, "quota"):
            return
        try:
            q = self.kaggle.quota()
        except Exception as exc:
            q = {"error": repr(exc)[:200]}
        self.store.set_json("kaggle_quota", {**(q or {}), "checked_epoch": self.clock(), "checked_at": utcnow()})

    def notify(self, run: dict | None, kind: str, subject: str, text: str) -> None:
        if not self.notifier:
            return
        sent = self.notifier.send(kind, subject, text)
        if sent and run is not None:
            event(run, f"alert sent ({', '.join(sent)}): {subject}")

    def refresh_serving(self, force: bool = False) -> None:
        cached = self.store.get_json("serving") or {}
        if not force and self.clock() - cached.get("checked_epoch", 0) < 60:
            return
        info = {"checked_at": utcnow(), "checked_epoch": self.clock()}
        try:
            info["worker"] = self.probe()
        except Exception as exc:
            info["worker_error"] = repr(exc)
        try:
            info["alias"] = self._s3_json(f"{self.prefix}/aliases/{self.alias}.json")
            info["alias_name"] = self.alias
        except Exception as exc:
            info["alias_error"] = repr(exc)
        self.store.set_json("serving", info)

    # ---------------------------------------------------------------- follow the Kaggle run
    def monitor(self, run: dict) -> None:
        k = run["kaggle"]
        state, message = self.kaggle.status()
        if state != k.get("status"):
            event(run, f"Kaggle status: {state}" + (f" ({message})" if message else ""), source="kaggle")
        k["status"], k["message"] = state, message
        if state in ACTIVE_KAGGLE:
            k["seen_active"] = True
        if state == "running" and run["phases"]["kaggle_start"]["status"] == "pending":
            set_phase(run, "kaggle_start", "running")

        live = self.live_progress(run["id"])
        if live:
            self._merge_live(run, live)
            k["seen_active"] = True
        stop = self.store.stop_request(run["id"])
        if stop and not run.get("stop_requested_at"):
            run["stop_requested_at"], run["stop_requested_by"] = stop["at"], stop["by"]
            event(run, f"stop requested from the dashboard by {stop['by']}: the notebook stops at its next check (~20 s)",
                  "warning", source="admin", ts=stop["at"])
        self.refresh_comet(run)
        self.check_stuck(run, live)

        pushed = _parse_ts(k.get("pushed_at")) or self.clock()
        if state == "complete" or state in TERMINAL_KAGGLE_ERRORS:
            # right after a push Kaggle may still report the PREVIOUS version's final state: ignore that
            if not k["seen_active"] and self.clock() - pushed < 180:
                return
            self.refresh_comet(run, force=True)
            if state == "complete":
                self._finish(run, live)
            elif run.get("stop_requested_at"):
                self._stopped(run)
            else:
                self._fail(run, f"Kaggle run ended with status '{state}'" + (f": {message}" if message else ""))
            return
        if self.clock() - pushed > self.cfg.pipeline_max_run_hours * 3600:
            self._fail(run, f"no result after {self.cfg.pipeline_max_run_hours} h (Kaggle limit is 12 h)")

    def refresh_comet(self, run: dict, force: bool = False) -> None:
        """Copy the run's Comet experiment (metrics, params, console, files) into the run record every 30 s."""
        data = (run.get("live") or {}).get("data") or {}
        key = data.get("comet_key") or (run.get("result") or {}).get("comet_experiment_key")
        info = run.setdefault("comet", {})
        info.update(workspace=data.get("comet_workspace") or self.cfg.comet_workspace,
                    project=data.get("comet_project") or self.cfg.comet_project, key=key,
                    url=data.get("comet_url") or (run.get("result") or {}).get("comet_url"))
        if not self.comet:
            info["enabled"] = False
            return
        info["enabled"] = True
        if not key or (not force and self.clock() - (info.get("fetched_epoch") or 0) < 30):
            return
        try:
            info.update(self.comet.experiment(key), error=None)
        except Exception as exc:
            info["error"] = str(exc)[:300]
        info["fetched_epoch"], info["fetched_at"] = self.clock(), utcnow()

    def check_stuck(self, run: dict, live: dict | None) -> None:
        """Alert once when a started notebook has sent no heartbeat for PIPELINE_STUCK_MINUTES."""
        updated = _parse_ts((live or {}).get("updated_at"))
        if not updated or run.get("stuck_alerted") or (live or {}).get("status") != "running":
            return
        silent = self.clock() - updated
        if silent > self.cfg.pipeline_stuck_minutes * 60:
            run["stuck_alerted"] = True
            msg = f"no heartbeat from the Kaggle notebook for {int(silent // 60)} min (run {run['id']})"
            event(run, msg, "warning")
            self.notify(run, "stuck", "Retraining run looks stuck", msg)

    def _stopped(self, run: dict) -> None:
        for key in PHASE_KEYS:
            if run["phases"][key]["status"] == "running":
                set_phase(run, key, "stopped", f"stopped by {run.get('stop_requested_by') or 'admin'}")
        run["status"], run["error"] = "stopped", None
        event(run, "run stopped from the dashboard: nothing deployed, the dataset is not marked as trained", "warning")
        self.notify(run, "stopped", "Retraining run stopped", f"Run {run['id']} ({run['dataset']['zip']}) was stopped "
                                                            f"by {run.get('stop_requested_by')}. The served model is unchanged.")
        self._close(run)

    def _merge_live(self, run: dict, live: dict) -> None:
        if run["phases"]["kaggle_start"]["status"] != "done":
            set_phase(run, "kaggle_start", "done", (live.get("gpu") or {}).get("name") or "notebook running")
        for key, phase in (live.get("phases") or {}).items():
            if key in run["phases"]:
                run["phases"][key].update({k: v for k, v in phase.items() if k in {"status", "started_at", "ended_at", "detail"}})
        notebook_events = live.get("events") or []
        for e in notebook_events[run.get("live_events_seen", 0):]:
            event(run, e.get("message", ""), e.get("level", "info"), source="kaggle", ts=e.get("ts"))
        run["live_events_seen"] = len(notebook_events)
        run["live"] = {k: live.get(k) for k in ("current", "progress", "epochs", "max_epochs", "gpu", "data",
                                                  "updated_at", "status", "console")}

    def _finish(self, run: dict, live: dict | None) -> None:
        set_phase(run, "collect", "running")
        result = ((live or {}).get("data") or {}).get("result")
        if not result:
            try:
                out = Path(self.cfg.pipeline_work_dir) / run["id"] / "output"
                files = self.kaggle.output(out)
                if (out / "pipeline_result.json").exists():
                    result = json.loads((out / "pipeline_result.json").read_text())
                event(run, f"downloaded Kaggle output: {len(files)} files")
            except Exception as exc:
                event(run, f"could not download Kaggle output: {exc}", "warning")
        if not result:
            self._fail(run, "the notebook finished without a pipeline result")
            return
        run["result"] = result
        set_phase(run, "collect", "done", f"model {result.get('version')} · gate {result.get('status')}")
        for key in NOTEBOOK_PHASES:
            if run["phases"][key]["status"] in {"running", "pending"}:
                set_phase(run, key, "done")
        self.store.clear_failures(run["dataset"]["fingerprint"])
        gate = result.get("gate") or {}
        over = result.get("overfitting") or {}
        summary = (f"test mAP@50 {_fmt(result.get('test_map50'))} vs served model {_fmt(gate.get('baseline_test_map50'))}; "
                   f"overfitting check: validation {_fmt(over.get('val_map50'))} vs test {_fmt(over.get('test_map50'))}, "
                   f"gap {_fmt(over.get('val_test_gap'))} (max {over.get('max_val_test_gap', self.cfg.gate_max_val_test_gap)})")
        if result.get("status") == "deployed":
            run["status"] = "deploying"
            set_phase(run, "hot_reload", "running", f"alias '{self.alias}' → {result.get('version')}; waiting for "
                                                     f"workers (poll every {self.cfg.model_poll_seconds}s)")
            event(run, f"gate PASSED ({summary}); new model {result.get('version')} deployed to alias '{self.alias}'")
            self.check_reload(run)
        else:
            reasons = "; ".join(gate.get("reasons") or []) or result.get("status")
            set_phase(run, "hot_reload", "skipped", "gate did not deploy the model: the served model stays")
            run["status"] = "rejected" if result.get("status") == "rejected" else "approved"
            event(run, f"gate {result.get('status')} ({summary}): {reasons}. Served model unchanged.", "warning")
            self.notify(run, run["status"], "Retrained model was not deployed",
                        f"Run {run['id']} on {run['dataset']['zip']}: {reasons}. The current model keeps serving.")
            self._close(run)

    def check_reload(self, run: dict) -> None:
        target = (run.get("result") or {}).get("version")
        try:
            serving = self.probe()
        except Exception as exc:
            serving = None
            event(run, f"cannot reach an inference worker: {exc!r}", "warning")
        served = (serving or {}).get("detector_version")
        if served and served == target:
            run["served_after"] = served
            set_phase(run, "hot_reload", "done", f"workers now serve {served}")
            run["status"] = "succeeded"
            event(run, f"EC2 workers hot-reloaded: now serving {served}")
            self.refresh_serving(force=True)
            r = run.get("result") or {}
            self.notify(run, "deployed", "New signature model is live",
                        f"{served} is now serving (test mAP@50 {_fmt(r.get('test_map50'))}, dataset {run['dataset']['zip']}).")
            self._close(run)
            return
        started = _parse_ts(run["phases"]["hot_reload"].get("started_at")) or self.clock()
        if self.clock() - started > self.cfg.model_poll_seconds + 600:
            set_phase(run, "hot_reload", "failed", f"workers still serve {served} after "
                                                   f"{int(self.clock() - started) // 60} min; check worker logs")
            run["status"] = "succeeded_reload_pending"
            event(run, "model deployed to S3 but the workers have not reloaded it yet", "warning")
            self._close(run)

    def _fail(self, run: dict, reason: str, fetch_logs: bool = True) -> None:
        for key in PHASE_KEYS:
            if run["phases"][key]["status"] == "running":
                set_phase(run, key, "failed", reason[:200])
        if fetch_logs:
            try:
                run["log_tail"] = self.kaggle.logs()
            except Exception as exc:
                run["log_tail"] = f"(could not fetch the Kaggle log: {exc})"
        run["status"], run["error"] = "failed", reason
        event(run, reason, "error")
        self.store.add_failure(run["dataset"]["fingerprint"])
        self.notify(run, "failed", "Retraining run failed", f"Run {run['id']} ({run['dataset']['zip']}): {reason}")
        self._close(run)

    def _close(self, run: dict) -> None:
        for key in PHASE_KEYS:
            if run["phases"][key]["status"] == "pending":
                set_phase(run, key, "skipped")
        run["finished_at"] = utcnow()
        self.store.save_run(run)
        self.store.release_active(run["id"])


# ===================================================================== production wiring
def build_orchestrator(settings=None) -> Orchestrator:
    import boto3
    import redis

    from .celery_app import MODEL_INFO_TASK, celery_app
    from .config import settings as default_settings

    cfg = settings or default_settings

    def probe() -> dict | None:
        result = celery_app.send_task(MODEL_INFO_TASK, queue=cfg.inference_queue)
        try:
            return result.get(timeout=8, disable_sync_subtasks=False)
        finally:
            result.forget()

    from .alerts import Notifier
    from .comet_client import CometClient

    store = PipelineStore(redis.Redis.from_url(cfg.broker_url))
    return Orchestrator(
        cfg, store, boto3.client("s3"),
        HfInspector(cfg.hf_token), KaggleCLI(cfg.kaggle_username, cfg.kaggle_kernel_slug, cfg.kaggle_secrets_slug,
                                             cfg.kaggle_accelerator), probe,
        comet=CometClient(cfg.comet_api_key, cfg.comet_base_url) if cfg.comet_api_key else None,
        notifier=Notifier(cfg, store))


# ===================================================================== admin actions (API process, admin token)
STOPPABLE_UNTIL = PHASE_KEYS.index("gate")  # once the gate runs, the deploy decision is being written


class ActionError(ValueError):
    pass


def request_stop(store: PipelineStore, s3, cfg, run_id: str | None, who: str) -> dict:
    """Ask the Kaggle notebook to stop: a small control file in S3 that it checks every heartbeat (~20 s)."""
    run_id = run_id or store.active()
    run = store.get_run(run_id) if run_id else None
    if not run or run["status"] != "running":
        raise ActionError("there is no running training run to stop")
    if run["phases"]["kaggle_submit"]["status"] != "done":
        raise ActionError("the Kaggle job has not been submitted yet; try again in a few seconds")
    if any(run["phases"][k]["status"] in {"running", "done"} for k in PHASE_KEYS[STOPPABLE_UNTIL:]):
        raise ActionError("too late to stop: the validation gate is already deciding about deployment")
    prefix = cfg.model_s3_prefix.strip("/")
    s3.put_object(Bucket=cfg.model_s3_bucket, Key=f"{prefix}/pipeline_runs/control/{run['id']}.json",
                  Body=json.dumps({"stop": True, "by": who, "at": utcnow()}).encode(), ContentType="application/json")
    store.request_stop(run["id"], who)
    store.audit("stop", f"stop requested for {run['id']} ({run['dataset']['zip']})", who)
    return {"stopping": run["id"]}


def rollback(store: PipelineStore, s3, cfg, who: str) -> dict:
    """Point the serving alias back to the version recorded as `previous_version` (workers hot-reload it)."""
    prefix, alias = cfg.model_s3_prefix.strip("/"), cfg.model_alias or "latest"
    if store.active() and (store.get_run(store.active()) or {}).get("status") == "deploying":
        raise ActionError("a deployment is in progress; wait until it finishes")

    def read(key):
        try:
            return json.loads(s3.get_object(Bucket=cfg.model_s3_bucket, Key=key)["Body"].read())
        except Exception:
            return None

    current = read(f"{prefix}/aliases/{alias}.json")
    target = (current or {}).get("previous_version")
    if not target:
        raise ActionError(f"alias '{alias}' has no previous version to roll back to")
    manifest = read(f"{prefix}/versions/{target}/manifest.json")
    if not manifest:
        raise ActionError(f"version {target} has no manifest in S3; refusing to roll back to it")
    body = {"version": target, "manifest_key": f"{prefix}/versions/{target}/manifest.json",
            "artifact_key": f"{prefix}/versions/{target}/artifact.zip", "sha256": manifest.get("artifact_sha256"),
            "stage": "rollback", "previous_version": current["version"], "rolled_back_at": utcnow(), "rolled_back_by": who}
    s3.put_object(Bucket=cfg.model_s3_bucket, Key=f"{prefix}/aliases/{alias}.json", Body=json.dumps(body, indent=2).encode(),
                  ContentType="application/json", ServerSideEncryption="AES256")
    store.audit("rollback", f"alias '{alias}': {current['version']} -> {target}; workers switch within "
                            f"{max(1, round(cfg.model_poll_seconds / 60))} min", who)
    store.r.delete("pipeline:serving")  # the next tick re-reads the alias and asks a worker what it serves
    return {"alias": alias, "from": current["version"], "to": target}


def set_alerts(store: PipelineStore, prefs: dict, who: str) -> dict:
    current = store.get_json("alerts") or {}
    changed = {k: bool(v) for k, v in prefs.items() if k in {"email", "slack", "stuck", "trigger"}}
    current.update(changed)
    store.set_json("alerts", current)
    store.audit("alerts", ", ".join(f"{k} {'on' if v else 'off'}" for k, v in changed.items()) or "no change", who)
    return current


MODE_EPOCHS = {"smoke": 1, "full": 8}
MAX_EPOCHS = 20  # Kaggle stops a notebook after 12 h; full mode takes about 25-30 min per epoch on a T4
EPOCH_SECONDS = {"smoke": 360, "full": 1650}


def training_settings(store: PipelineStore, cfg, mode: str | None = None) -> dict:
    """Max epochs for the next run: dashboard setting, else RETRAIN_EPOCHS, else the mode's default."""
    mode = mode or cfg.retrain_mode
    saved = (store.get_json("training") or {}).get("epochs")
    if saved:
        epochs, source = int(saved), "dashboard"
    elif cfg.retrain_epochs:
        epochs, source = int(cfg.retrain_epochs), "RETRAIN_EPOCHS in .env"
    else:
        epochs, source = MODE_EPOCHS.get(mode, 8), f"{mode} mode default"
    epochs = max(1, min(MAX_EPOCHS, epochs))
    return {"epochs": epochs, "source": source, "mode": mode, "mode_default": MODE_EPOCHS.get(mode, 8),
            "env_epochs": cfg.retrain_epochs, "max_epochs": MAX_EPOCHS, "seconds_per_epoch": EPOCH_SECONDS.get(mode, 1650)}


def set_training(store: PipelineStore, cfg, epochs: int | None, who: str) -> dict:
    """Save max epochs for the next runs (None = back to RETRAIN_EPOCHS / the mode default). A running run keeps its value."""
    before = training_settings(store, cfg)["epochs"]
    if epochs is None:
        store.set_json("training", {})
    else:
        if not 1 <= int(epochs) <= MAX_EPOCHS:
            raise ActionError(f"epochs must be between 1 and {MAX_EPOCHS}")
        store.set_json("training", {"epochs": int(epochs)})
    after = training_settings(store, cfg)
    store.audit("training", f"max epochs {before} -> {after['epochs']} ({after['source']}); applies from the next run", who)
    return after


# ===================================================================== dashboard read model
DEFAULT_PHASE_SECONDS = {"kaggle_submit": 15, "kaggle_start": 120, "download": 150, "parse": 30, "clean": 420,
                         "near_dup": 600, "split": 60, "warm_start": 40, "evaluation": 300, "calibration": 180,
                         "package": 45, "publish": 45, "gate": 300, "collect": 10, "hot_reload": 300}
TRAINING_DEFAULT_SECONDS = {"full": 1650 * 8, "smoke": 360}


def _phase_seconds(run: dict, key: str) -> float | None:
    p = run["phases"].get(key) or {}
    a, b = _parse_ts(p.get("started_at")), _parse_ts(p.get("ended_at"))
    return (b - a) if (a and b and b >= a) else None


def estimate_finish(run: dict, history: list[dict], now: float) -> dict | None:
    """Time left for a live run: median step durations of earlier runs in the same mode (defaults until there are any)."""
    if run["status"] not in {"running", "deploying"}:
        return None
    done = [r for r in history if r["id"] != run["id"] and r.get("status") in {"succeeded", "rejected", "approved"}
            and r.get("mode") == run.get("mode")]
    remaining, basis = 0.0, "history" if done else "defaults"
    for key in PHASE_KEYS:
        st = run["phases"][key]
        if st["status"] in {"done", "skipped", "failed", "stopped"}:
            continue
        samples = sorted(x for x in (_phase_seconds(r, key) for r in done) if x is not None)
        typical = samples[len(samples) // 2] if samples else (
            TRAINING_DEFAULT_SECONDS.get(run.get("mode"), 3600) if key == "training" else DEFAULT_PHASE_SECONDS.get(key, 30))
        if key == "training" and not samples and run.get("epochs"):
            typical = EPOCH_SECONDS.get(run.get("mode"), 1650) * run["epochs"]
        if key == "training":
            eps = ((run.get("live") or {}).get("epochs") or [])
            max_ep = (run.get("live") or {}).get("max_epochs") or run.get("epochs")
            secs = [e.get("epoch_seconds") for e in eps if isinstance(e.get("epoch_seconds"), (int, float))]
            if secs and max_ep:
                typical = sum(secs) / len(secs) * max_ep  # upper bound: early stopping may end sooner
        started = _parse_ts(st.get("started_at"))
        elapsed = (now - started) if (st["status"] == "running" and started) else 0
        remaining += max(typical - elapsed, 0 if st["status"] != "running" else typical * 0.05)
    return {"remaining_seconds": round(remaining), "finish_at": dt.datetime.fromtimestamp(now + remaining, dt.timezone.utc).isoformat(timespec="seconds"),
            "basis": basis, "runs_used": len(done)}


def build_lineage(runs: list[dict], serving_version: str | None, selected: dict | None) -> dict:
    """Base checkpoint -> first model -> every deployed retrain, plus the selected run if it was not deployed."""
    deployed = sorted((r for r in runs if (r.get("result") or {}).get("status") == "deployed"), key=lambda r: r["created_at"])
    models = []
    first_parent = (deployed[0]["result"].get("init_version") if deployed else None) or (None if deployed else serving_version)
    if first_parent:
        models.append({"version": first_parent, "source": "first model (Colab fine-tune)"})
    for r in deployed:
        res = r["result"]
        models.append({"version": res.get("version"), "source": "retrain on Kaggle", "run_id": r["id"],
                       "dataset": r["dataset"].get("zip"), "dataset_sha256": r["dataset"].get("fingerprint"),
                       "test_map50": res.get("test_map50"), "created_at": r["created_at"]})
    if serving_version and serving_version not in [m["version"] for m in models]:
        models.append({"version": serving_version, "source": "served (rolled back or set by hand)"})
    current = None
    if selected and (selected.get("result") or {}).get("status") != "deployed":
        current = {"run_id": selected["id"], "status": selected["status"],
                   "version": (selected.get("result") or {}).get("version"), "dataset": selected["dataset"].get("zip"),
                   "dataset_sha256": selected["dataset"].get("fingerprint")}
    return {"base": "PekingU/rtdetr_v2_r18vd", "models": models, "serving": serving_version, "current": current}


def dashboard_state(store: PipelineStore, cfg, run_id: str | None = None) -> dict[str, Any]:
    active = store.active()
    ids = store.run_ids(20)
    runs = [r for r in (store.get_run(i) for i in ids) if r]
    run = store.get_run(run_id or active or (ids[0] if ids else "")) if (run_id or active or ids) else None
    if run and (stop := store.stop_request(run["id"])) and not run.get("stop_requested_at"):
        run["stop_requested_at"], run["stop_requested_by"] = stop["at"], stop["by"]
    hb = store.last_heartbeat()
    user = cfg.kaggle_username
    serving = store.get_json("serving") or {}
    serving_version = (serving.get("worker") or {}).get("detector_version") or (serving.get("alias") or {}).get("version")
    prev_ds = next(({"run_id": r["id"], "zip": r["dataset"].get("zip"), "summary": r["live"]["data"]["dataset_summary"]}
                    for r in runs if run and r["id"] != run["id"] and r["created_at"] < run["created_at"]
                    and ((r.get("live") or {}).get("data") or {}).get("dataset_summary")), None)
    webhooks = [d for d in store.decisions(50) if d.get("decision") == "webhook"]
    alert_prefs = store.get_json("alerts") or {}
    channels = {"email": bool(cfg.smtp_host and cfg.alert_email_to), "slack": bool(cfg.alert_webhook_url)}
    return json_safe({
        "server_time": utcnow(),
        "phases": [{"key": k, "label": label, "where": where} for k, label, where in PHASES],
        "orchestrator": {"backend": "ec2", "online": bool(hb and time.time() - hb < 4 * cfg.pipeline_tick_seconds + 30),
                         "last_heartbeat": dt.datetime.fromtimestamp(hb, dt.timezone.utc).isoformat() if hb else None},
        "config": {"hf_repo": cfg.hf_dataset_repo,
                   "hf_url": f"https://huggingface.co/datasets/{cfg.hf_dataset_repo}" if cfg.hf_dataset_repo else None,
                   "mode": cfg.retrain_mode, "deploy_alias": cfg.model_alias, "poll_minutes": cfg.pipeline_poll_minutes,
                   "gate_floor": cfg.gate_min_test_map50, "gate_max_regression": cfg.gate_max_regression,
                   "gate_max_val_test_gap": cfg.gate_max_val_test_gap, "comet_project": cfg.comet_project,
                   "comet_workspace": cfg.comet_workspace, "comet_enabled": bool(cfg.comet_api_key),
                   "comet_project_url": (f"{cfg.comet_base_url.rstrip('/')}/{cfg.comet_workspace}/{cfg.comet_project}"
                                         if cfg.comet_workspace else None),
                   "kaggle_url": f"https://www.kaggle.com/code/{user}/{cfg.kaggle_kernel_slug}" if user else None,
                   "accelerator": cfg.kaggle_accelerator, "admin_enabled": bool(cfg.pipeline_admin_token),
                   "model_poll_seconds": cfg.model_poll_seconds,
                   "s3_prefix": f"s3://{cfg.model_s3_bucket}/{cfg.model_s3_prefix.strip('/')}"},
        "active_run_id": active,
        "run": run,
        "eta": estimate_finish(run, runs, time.time()) if run else None,
        "previous_dataset": prev_ds,
        "lineage": build_lineage(runs, serving_version, run),
        "runs": [run_summary(r) for r in runs],
        "decisions": store.decisions(30),
        "audit": store.audit_log(30),
        "serving": serving,
        "rollback_to": (serving.get("alias") or {}).get("previous_version"),
        "kaggle_quota": store.get_json("kaggle_quota"),
        "training": training_settings(store, cfg),
        "alerts": {"channels": channels, "prefs": {"email": alert_prefs.get("email", channels["email"]),
                                                   "slack": alert_prefs.get("slack", channels["slack"]),
                                                   "stuck": alert_prefs.get("stuck", True),
                                                   "trigger": alert_prefs.get("trigger", True)}},
        "last_webhook_at": webhooks[0]["ts"] if webhooks else None,
        "last_check": store.get_json("last_check"),
        "pending_recheck": bool(store.r.exists("pipeline:pending")),
    })
