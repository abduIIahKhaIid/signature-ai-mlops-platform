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
import json
import logging
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
        self.r.set(key, json.dumps(value, default=str), ex=ex)

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
        self.r.lpush("pipeline:decisions", json.dumps(entry, default=str))
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
    if status in {"done", "failed", "skipped"}:
        phase.setdefault("started_at", now)
        phase["ended_at"] = now
    phase["status"] = status
    if detail is not None:
        phase["detail"] = detail


def run_summary(run: dict) -> dict:
    result = run.get("result") or {}
    return {
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

    def output(self, dest: Path) -> list[str]:
        dest.mkdir(parents=True, exist_ok=True)
        r = self._run("kernels", "output", self.kernel, "-p", str(dest), "--force", timeout=300)
        if r.returncode != 0:
            raise RuntimeError((r.stdout + r.stderr)[-300:])
        return [str(p.relative_to(dest)) for p in dest.rglob("*") if p.is_file()]


# ===================================================================== orchestrator
class Orchestrator:
    def __init__(self, settings, store: PipelineStore, s3, hf: HfInspector, kaggle: KaggleCLI,
                 probe: Callable[[], dict | None], clock: Callable[[], float] = time.time):
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
            return self.store.decide("blocked", "HF_DATASET_REPO is not set on the server", source=source)
        active = self.store.active()
        if active:
            self.store.set_pending()
            return self.store.decide("deferred", f"run {active} is in progress; the dataset will be re-checked "
                                                 "as soon as it finishes", source=source, hf_sha=hf_sha, run_id=active)
        try:
            repo_state = self.hf.inspect(repo)
        except Exception as exc:
            return self.store.decide("error", f"could not read Hugging Face repo {repo}: {exc}", source=source)
        self.store.set_json("last_check", {"ts": utcnow(), "source": source, "commit": repo_state["commit"],
                                           "zips": repo_state["zips"][:5], "url": repo_state["url"]})
        base = {"source": source, "hf_sha": repo_state["commit"]}
        if not repo_state["zips"]:
            return self.store.decide("no_dataset", f"no .zip dataset in {repo}@{repo_state['commit'][:8]}: nothing to "
                                                   "train. Upload a reviewed dataset ZIP to start training.", **base)
        newest = repo_state["zips"][0]
        fp = newest["fingerprint"]
        base.update(zip=newest["path"], fingerprint=fp)
        try:
            marker = self.trained_marker(fp)
        except Exception as exc:  # unknown -> do NOT start (a duplicate GPU run is worse than waiting)
            return self.store.decide("error", f"cannot read the trained-dataset record in S3: {exc}", **base)
        if marker and not force:
            return self.store.decide(
                "skipped_trained",
                f"{newest['path']} has the same content (SHA-256 {fp[:12]}…) as a dataset already trained in model "
                f"{marker.get('version')} (gate: {marker.get('status')}); not retraining", marker=marker, **base)
        fails = self.store.failures(fp)
        if fails >= self.cfg.pipeline_max_auto_attempts and not force and source != "manual":
            return self.store.decide("skipped_failed", f"{newest['path']} failed {fails} times; not retrying "
                                                       "automatically. Use 'Retrain now' on the dashboard.", **base)
        problems = self.kaggle.problems()
        if problems:
            return self.store.decide("blocked", "Kaggle is not configured: " + "; ".join(problems), **base)
        ready, text = self.kaggle.secrets_ready()
        if not ready:
            return self.store.decide("blocked", f"Kaggle secrets dataset {self.kaggle.secrets_dataset} is not ready "
                                                f"({text}). See pipeline/README_PIPELINE.md, step 'Kaggle secrets'.", **base)

        dataset = {"repo": repo, "commit": repo_state["commit"], "url": repo_state["url"], "zip": newest["path"],
                   "size_bytes": newest["size"], "sha256": newest["sha256"], "fingerprint": fp,
                   "committed_at": newest["committed_at"], "commit_title": newest["commit_title"],
                   "other_zips": [z["path"] for z in repo_state["zips"][1:]]}
        run = new_run({"source": source, "hf_sha": hf_sha, "force": force, "note": note, "received_at": utcnow()},
                      dataset, self.cfg.retrain_mode)
        if not self.store.claim_active(run["id"]):
            self.store.set_pending()
            return self.store.decide("deferred", "another run started at the same moment; re-checking later", **base)
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
        self.store.decide("started", f"run {run['id']} started for {newest['path']}", run_id=run["id"], **base)
        self._submit(run)
        self.store.save_run(run)
        return {"decision": "started", "run_id": run["id"]}

    def _submit(self, run: dict) -> None:
        set_phase(run, "kaggle_submit", "running")
        ds = run["dataset"]
        try:
            sys.path.insert(0, self.cfg.pipeline_dir)
            import kaggle_job

            build = Path(self.cfg.pipeline_work_dir) / run["id"] / "kaggle"
            kaggle_job.cmd_build(types.SimpleNamespace(
                kernel=self.kaggle.kernel, mode=run["mode"], hf_repo=ds["repo"], hf_zip=ds["zip"],
                hf_revision=ds["commit"], secrets_dataset=self.kaggle.secrets_dataset, deploy_alias=self.alias,
                no_deploy=False, gate_floor=self.cfg.gate_min_test_map50, gate_max_regression=self.cfg.gate_max_regression,
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
        else:
            last = self.store.get_json("last_poll") or 0
            if self.store.pop_pending():
                self.request_check("pending", note="re-check after the previous run")
            elif self.cfg.pipeline_poll_minutes and self.clock() - last >= self.cfg.pipeline_poll_minutes * 60:
                self.store.set_json("last_poll", self.clock())
                self.request_check("schedule", note=f"fallback poll every {self.cfg.pipeline_poll_minutes} min")
        self.refresh_serving()

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

        pushed = _parse_ts(k.get("pushed_at")) or self.clock()
        if state == "complete" or state in TERMINAL_KAGGLE_ERRORS:
            # right after a push Kaggle may still report the PREVIOUS version's final state: ignore that
            if not k["seen_active"] and self.clock() - pushed < 180:
                return
            if state == "complete":
                self._finish(run, live)
            else:
                self._fail(run, f"Kaggle run ended with status '{state}'" + (f": {message}" if message else ""))
            return
        if self.clock() - pushed > self.cfg.pipeline_max_run_hours * 3600:
            self._fail(run, f"no result after {self.cfg.pipeline_max_run_hours} h (Kaggle limit is 12 h)")

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
                                                  "updated_at", "status")}

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
        summary = f"test mAP@50 {_fmt(result.get('test_map50'))} vs served model {_fmt(gate.get('baseline_test_map50'))}"
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

    return Orchestrator(
        cfg, PipelineStore(redis.Redis.from_url(cfg.broker_url)), boto3.client("s3"),
        HfInspector(cfg.hf_token), KaggleCLI(cfg.kaggle_username, cfg.kaggle_kernel_slug, cfg.kaggle_secrets_slug,
                                             cfg.kaggle_accelerator), probe)


def dashboard_state(store: PipelineStore, cfg, run_id: str | None = None) -> dict[str, Any]:
    active = store.active()
    ids = store.run_ids(20)
    run = store.get_run(run_id or active or (ids[0] if ids else "")) if (run_id or active or ids) else None
    hb = store.last_heartbeat()
    user = cfg.kaggle_username
    return {
        "server_time": utcnow(),
        "phases": [{"key": k, "label": label, "where": where} for k, label, where in PHASES],
        "orchestrator": {"backend": cfg.retrain_backend, "online": bool(hb and time.time() - hb < 4 * cfg.pipeline_tick_seconds + 30),
                         "last_heartbeat": dt.datetime.fromtimestamp(hb, dt.timezone.utc).isoformat() if hb else None},
        "config": {"hf_repo": cfg.hf_dataset_repo,
                   "hf_url": f"https://huggingface.co/datasets/{cfg.hf_dataset_repo}" if cfg.hf_dataset_repo else None,
                   "mode": cfg.retrain_mode, "deploy_alias": cfg.model_alias, "poll_minutes": cfg.pipeline_poll_minutes,
                   "gate_floor": cfg.gate_min_test_map50, "gate_max_regression": cfg.gate_max_regression,
                   "kaggle_url": f"https://www.kaggle.com/code/{user}/{cfg.kaggle_kernel_slug}" if user else None,
                   "accelerator": cfg.kaggle_accelerator, "admin_enabled": bool(cfg.pipeline_admin_token),
                   "s3_prefix": f"s3://{cfg.model_s3_bucket}/{cfg.model_s3_prefix.strip('/')}"},
        "active_run_id": active,
        "run": run,
        "runs": [run_summary(r) for r in (store.get_run(i) for i in ids) if r],
        "decisions": store.decisions(30),
        "serving": store.get_json("serving"),
        "last_check": store.get_json("last_check"),
        "pending_recheck": bool(store.r.exists("pipeline:pending")),
    }
