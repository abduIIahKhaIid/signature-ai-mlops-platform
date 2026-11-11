"""Kaggle side of the retraining pipeline. Used by the EC2 orchestrator (signature_service/app/retrain.py).
The commands below can also be run by hand on EC2 for debugging.

  python pipeline/kaggle_job.py secrets  --dataset <owner>/signatureai-pipeline-secrets
  python pipeline/kaggle_job.py build    --kernel <owner>/signatureai-retrain --mode smoke --hf-revision <sha> \
                                         --secrets-dataset <owner>/signatureai-pipeline-secrets --out build/kaggle
  kaggle kernels push -p build/kaggle
  python pipeline/kaggle_job.py wait     --kernel <owner>/signatureai-retrain --out build/output
  python pipeline/kaggle_job.py summary  --result build/output/pipeline_result.json

Needs the Kaggle CLI authenticated through KAGGLE_USERNAME / KAGGLE_KEY (or KAGGLE_API_TOKEN).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SECRET_NAMES = ["COMET_API_KEY", "COMET_WORKSPACE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
                "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_S3_BUCKET", "HF_TOKEN"]
REQUIRED_SECRETS = ["COMET_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION", "AWS_S3_BUCKET"]

MODES = {
    # quick end-to-end proof: warm start from the served model, small subset, 1 epoch (~30-40 min incl. data prep)
    "smoke": dict(EPOCHS=1, MAX_TRAIN_IMAGES=2000, MAX_VAL_IMAGES=500, CALIB_MAX_IMAGES=500,
                  EARLY_STOPPING_MIN_EPOCHS=1, EARLY_STOPPING_PATIENCE=1),
    # real retrain on the full updated dataset
    "full": dict(EPOCHS=8, MAX_TRAIN_IMAGES=None, MAX_VAL_IMAGES=None, CALIB_MAX_IMAGES=1500,
                 EARLY_STOPPING_MIN_EPOCHS=2, EARLY_STOPPING_PATIENCE=2),
}


def run(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    print("+", " ".join(args), flush=True)
    return subprocess.run(args, check=check, capture_output=True, text=True)


# ---------------------------------------------------------------- secrets dataset
def cmd_secrets(a) -> None:
    """Upload run secrets as a PRIVATE Kaggle dataset that the kernel mounts read-only."""
    values = {k: os.environ[k] for k in SECRET_NAMES if os.environ.get(k)}
    missing = [k for k in REQUIRED_SECRETS if k not in values]
    if missing:
        sys.exit(f"missing required secrets: {', '.join(missing)}")
    try:
        push_secrets(a.dataset, values)
    except RuntimeError as exc:
        sys.exit(str(exc))


def push_secrets(dataset: str, values: dict, wait_seconds: int = 600) -> None:
    """Create or update the private secrets dataset and wait until Kaggle has processed it (raises on failure).
    Also used by the EC2 orchestrator to sync the secrets from its .env before every run."""
    owner, slug = dataset.split("/", 1)
    with tempfile.TemporaryDirectory() as tmp:
        d = Path(tmp)
        (d / "pipeline_secrets.json").write_text(json.dumps(values))
        (d / "dataset-metadata.json").write_text(json.dumps(
            {"title": slug, "id": dataset, "licenses": [{"name": "CC0-1.0"}]}))
        r = run("kaggle", "datasets", "version", "-p", str(d), "-m", "pipeline run", check=False)
        text = (r.stdout + r.stderr).lower()
        if r.returncode != 0 or "error" in text or "not found" in text or "404" in text:
            print("no existing secrets dataset (or version failed) -> creating it (private)")
            r = run("kaggle", "datasets", "create", "-p", str(d), check=False)  # private unless --public
            text = (r.stdout + r.stderr).lower()
        print(r.stdout[-1500:], r.stderr[-1500:])  # the CLI never echoes file contents
        if r.returncode != 0 or ("error" in text and "already" not in text):
            raise RuntimeError("could not upload the secrets dataset: " + (r.stdout + r.stderr)[-300:])
    for _ in range(max(1, wait_seconds // 10)):  # wait until Kaggle has processed the new version
        status = run("kaggle", "datasets", "status", dataset, check=False).stdout.strip().lower()
        print("dataset status:", status)
        if "ready" in status:
            return
        time.sleep(10)
    raise RuntimeError("secrets dataset did not become ready")


# ---------------------------------------------------------------- notebook + metadata
def overrides_cell(a) -> str:
    cfg = dict(MODES[a.mode])
    cfg.update(
        PIPELINE_MODE=a.mode, ZIP_SOURCE="huggingface", HF_DATASET_REPO=a.hf_repo,
        HF_ZIP_FILENAME=a.hf_zip, HF_REVISION=a.hf_revision or "main",
        BATCH_SIZE=8, GRAD_ACCUM=1, NUM_WORKERS=4, USE_COMET=True, UPLOAD_TO_S3=True,
        S3_UPDATE_LATEST_ALIAS=False, PROMOTE_TO_PRODUCTION=False, RELOAD_FROM_S3=False, SAVE_TO_DRIVE=False,
        AUTO_DEPLOY=not a.no_deploy, DEPLOY_ALIAS=a.deploy_alias,
        # warm start from (and compare against) the model the workers serve, never from an unreviewed candidate
        INIT_FROM=a.deploy_alias,
        GATE_MIN_TEST_MAP50=a.gate_floor, GATE_MAX_REGRESSION=a.gate_max_regression,
        GATE_MAX_VAL_TEST_GAP=getattr(a, "gate_max_val_test_gap", 0.05),
        GITHUB_RUN_URL=a.github_run_url,
        PIPELINE_RUN_ID=getattr(a, "run_id", None), LIVE_PROGRESS=bool(getattr(a, "run_id", None)),
        DATASET_FINGERPRINT=getattr(a, "dataset_fingerprint", None) or None,
        EXPECTED_ZIP_SHA256=getattr(a, "expected_sha256", None) or None,
        COMET_WORKSPACE_NAME=getattr(a, "comet_workspace", None) or None,
    )
    if getattr(a, "comet_project", None):
        cfg["COMET_PROJECT"] = a.comet_project
    epochs = getattr(a, "epochs", None)
    if epochs:  # chosen on the dashboard or with RETRAIN_EPOCHS; early stopping can still end training sooner
        cfg["EPOCHS"] = int(epochs)
        cfg["EARLY_STOPPING_MIN_EPOCHS"] = min(cfg["EARLY_STOPPING_MIN_EPOCHS"], int(epochs))
        cfg["EARLY_STOPPING_PATIENCE"] = max(cfg["EARLY_STOPPING_PATIENCE"], 2) if int(epochs) >= 3 else cfg["EARLY_STOPPING_PATIENCE"]
    lines = ["# PIPELINE OVERRIDES (generated by pipeline/kaggle_job.py build)"]
    lines += [f"{k} = {v!r}" for k, v in cfg.items()]
    lines += [
        "WORKDIR = Path('/tmp/signature_ai_work')",
        "RAW_DIR = WORKDIR / 'raw'; RUN_DIR = WORKDIR / 'run'; REPORTS_DIR = RUN_DIR / 'reports'",
        "CLEAN_DIR = RUN_DIR / 'cleaned_coco'; MODEL_DIR = RUN_DIR / 'best_model'",
        "print('Pipeline overrides applied:', PIPELINE_MODE, '| HF revision', HF_REVISION, '| init', INIT_FROM)",
    ]
    return "\n".join(lines) + "\n"


def cmd_build(a) -> None:
    nb = json.loads((ROOT / "train_pipeline.ipynb").read_text(encoding="utf-8"))
    slot = [i for i, c in enumerate(nb["cells"]) if "".join(c["source"]).startswith("# PIPELINE OVERRIDES")]
    if len(slot) != 1:
        sys.exit("override cell not found in train_pipeline.ipynb")
    nb["cells"][slot[0]]["source"] = overrides_cell(a)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "train_pipeline.ipynb").write_text(json.dumps(nb, indent=1), encoding="utf-8")
    owner, slug = a.kernel.split("/", 1)
    meta = {
        "id": a.kernel, "title": slug, "code_file": "train_pipeline.ipynb", "language": "python",
        "kernel_type": "notebook", "is_private": True, "enable_gpu": True, "enable_internet": True,
        "dataset_sources": [a.secrets_dataset] if a.secrets_dataset else [],
        "competition_sources": [], "kernel_sources": [], "model_sources": [],
    }
    (out / "kernel-metadata.json").write_text(json.dumps(meta, indent=2))
    print(overrides_cell(a))
    print("kernel metadata:", json.dumps(meta))


# ---------------------------------------------------------------- wait + collect
def cmd_wait(a) -> None:
    deadline = time.time() + a.timeout
    last = ""
    time.sleep(30)  # give Kaggle time to queue the new version
    while time.time() < deadline:
        r = run("kaggle", "kernels", "status", a.kernel, check=False)
        text = (r.stdout + r.stderr).strip()
        m = re.search(r'status "?([\w.]+)"?', text)
        status = (m.group(1) if m else text).lower()
        if status != last:
            print(time.strftime("%H:%M:%S"), "kernel status:", status, flush=True)
            last = status
        if "complete" in status or "error" in status or "cancel" in status:
            break
        time.sleep(a.poll)
    else:
        Path(a.out).mkdir(parents=True, exist_ok=True)
        (Path(a.out) / "STILL_RUNNING").write_text(a.kernel)
        print(f"::warning::stopped waiting after {a.timeout}s; {a.kernel} keeps running on Kaggle. "
              "Its result will appear in S3 pipeline_runs/ and Comet, and the gate still deploys if it passes.")
        return
    Path(a.out).mkdir(parents=True, exist_ok=True)
    r = run("kaggle", "kernels", "output", a.kernel, "-p", a.out, check=False)
    print(r.stdout[-3000:], r.stderr[-3000:])
    if "complete" not in last:
        sys.exit(f"kernel finished with status {last}; see the log in {a.out}")


def cmd_summary(a) -> None:
    path = Path(a.result)
    if not path.exists():
        if (path.parent / "STILL_RUNNING").exists():
            text = ("## ⏳ Training still running on Kaggle\n\nGitHub stopped waiting (job time limit). The notebook "
                    "continues; check S3 `pipeline_runs/` and the Comet experiment for the result.\n")
            print(text)
            if os.environ.get("GITHUB_STEP_SUMMARY"):
                with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as f:
                    f.write(text)
            return
        sys.exit(f"{path} not found: the notebook did not reach the end")
    r = json.loads(path.read_text())
    icon = {"deployed": "✅", "approved_not_deployed": "🟡", "rejected": "⛔"}.get(r["status"], "❔")
    gate = r.get("gate", {})
    def f4(x):
        return f"{x:.4f}" if isinstance(x, (int, float)) else str(x)

    lines = [
        f"## {icon} Retraining result: `{r['status']}`",
        "",
        "| Field | Value |", "|---|---|",
        f"| Model version | `{r['version']}` |",
        f"| Mode | {r.get('mode')} (init from `{r.get('init_version') or r.get('init_from')}`) |",
        f"| HF dataset commit | `{r.get('hf_dataset_commit')}` |",
        f"| Images train / val / test | {r.get('train_images')} / {r.get('val_images')} / {r.get('test_images')} |",
        f"| Best val mAP@50 | {f4(r.get('best_val_map50'))} |",
        f"| **Test mAP@50** | **{f4(r.get('test_map50'))}** |",
        f"| Recommended threshold | {r.get('recommended_threshold')} |",
        f"| Dataset ZIP | `{r.get('hf_zip_filename')}` |",
        f"| Champion (served) on this test set | `{gate.get('baseline_version')}` → {f4(gate.get('baseline_test_map50'))} |",
        f"| Gate | passed={gate.get('passed')} · floor {gate.get('floor')} · max drop {gate.get('max_regression')} |",
        f"| Gate reasons | {'; '.join(gate.get('reasons') or []) or '—'} |",
        f"| Deployed to alias | {r.get('deploy_alias') or '—'} |",
        f"| S3 | `{r.get('s3_model_uri')}` |",
        f"| Comet | {r.get('comet_url') or r.get('comet_experiment_key')} |",
    ]
    text = "\n".join(lines) + "\n"
    print(text)
    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as f:
            f.write(text)


# ---------------------------------------------------------------- scheduled watcher
def cmd_check_hf(a) -> None:
    """Fallback trigger without a public HTTPS webhook: has the HF dataset moved since the last training?"""
    import urllib.request

    import boto3

    headers = {"User-Agent": "signatureai-pipeline"}
    if os.environ.get("HF_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['HF_TOKEN']}"
    url = f"https://huggingface.co/api/datasets/{a.hf_repo}/revision/main"
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        sha = json.loads(response.read())["sha"]
    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION"))
    key = f"{a.prefix.strip('/')}/pipeline_runs/hf_commits/{sha}.json"
    try:
        s3.head_object(Bucket=os.environ["AWS_S3_BUCKET"], Key=key)
        trained = True
    except Exception:
        trained = False
    print(f"HF {a.hf_repo}@main = {sha} | already trained: {trained}")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a") as f:
            f.write(f"hf_sha={sha}\nskip={'true' if trained else 'false'}\n")


def main() -> None:
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("secrets"); s.add_argument("--dataset", required=True)
    b = sub.add_parser("build")
    b.add_argument("--kernel", required=True)
    b.add_argument("--mode", choices=sorted(MODES), default="smoke")
    b.add_argument("--epochs", type=int, default=None, help="max epochs (default: the mode's value)")
    b.add_argument("--hf-repo", default="mabdullahkhalid/Signature_Dataset_Detection")
    b.add_argument("--hf-zip", default="auto", help="'auto' = most recently committed .zip in the repo")
    b.add_argument("--hf-revision", default="main")
    b.add_argument("--secrets-dataset", default="")
    b.add_argument("--deploy-alias", default="latest")
    b.add_argument("--no-deploy", action="store_true")
    b.add_argument("--gate-floor", type=float, default=0.75)
    b.add_argument("--gate-max-regression", type=float, default=0.02)
    b.add_argument("--gate-max-val-test-gap", type=float, default=0.05,
                   help="overfitting check: reject if validation mAP@50 - test mAP@50 is larger")
    b.add_argument("--comet-project", default=None, help="Comet project for this run (default: notebook CONFIG)")
    b.add_argument("--comet-workspace", default=None, help="Comet workspace (default: COMET_WORKSPACE secret)")
    b.add_argument("--github-run-url", default=None)
    b.add_argument("--run-id", default=None, help="pipeline run id: enables live progress to S3")
    b.add_argument("--dataset-fingerprint", default=None, help="dataset ZIP fingerprint (HF LFS sha256)")
    b.add_argument("--expected-sha256", default=None, help="refuse to train if the downloaded ZIP differs")
    b.add_argument("--out", default="build/kaggle")
    w = sub.add_parser("wait")
    w.add_argument("--kernel", required=True)
    w.add_argument("--out", default="build/output")
    w.add_argument("--timeout", type=int, default=5 * 3600)
    w.add_argument("--poll", type=int, default=60)
    m = sub.add_parser("summary"); m.add_argument("--result", required=True)
    c = sub.add_parser("check-hf")
    c.add_argument("--hf-repo", required=True)
    c.add_argument("--prefix", default="signatureai/detection")
    a = p.parse_args()
    {"secrets": cmd_secrets, "build": cmd_build, "wait": cmd_wait, "summary": cmd_summary,
     "check-hf": cmd_check_hf}[a.cmd](a)


if __name__ == "__main__":
    main()
