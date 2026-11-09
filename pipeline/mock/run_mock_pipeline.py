"""Mock end-to-end run of pipeline/train_pipeline.ipynb (the exact cells Kaggle runs), on CPU.

Only the outside world is replaced:
  Hugging Face -> a dataset ZIP on disk + fake HfApi / hf_hub_download (commit, file list with LFS sha256)
  Amazon S3    -> moto: in-process by default, or a running moto server when AWS_ENDPOINT_URL_S3 is set
                  (that is how pipeline/mock/run_mock_orchestrator.py shares one S3 with the EC2 orchestrator)
  Comet        -> a recorder that keeps every parameter / metric / asset the notebook logs
  GPU          -> CPU, tiny randomly initialised RT-DETRv2 (same architecture family, no download)

Usage:
  python pipeline/mock/run_mock_pipeline.py <repo_root>                      # standalone, writes evidence.json
  python pipeline/mock/run_mock_pipeline.py <repo_root> --notebook build/kaggle/train_pipeline.ipynb \
         --dataset-zip data.zip --hf-commit <sha>                             # run a notebook built by kaggle_job.py
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import io
import json
import os
import random
import sys
import time
import types
import zipfile
from pathlib import Path

import matplotlib

matplotlib.use("Agg")


def make_dataset_zip(path: Path, counts=None, seed: int = 7, dirty: bool = True) -> None:
    """Synthetic YOLO export like the dataset dashboard produces, optionally with deliberately dirty records."""
    from PIL import Image, ImageDraw

    counts = counts or {"train": 48, "valid": 12, "test": 12}
    rng = random.Random(seed)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("reviewed_dataset/data.yaml", "path: .\ntrain: train/images\nval: valid/images\ntest: test/images\nnc: 1\nnames:\n- signature\n")
        n = 0
        for split, count in counts.items():
            for i in range(count):
                n += 1
                w, h = rng.randint(500, 800), rng.randint(600, 900)
                img = Image.new("RGB", (w, h), (rng.randint(235, 255),) * 3)
                d = ImageDraw.Draw(img)
                for y in range(rng.randint(30, 80), h // 2, rng.randint(22, 40)):
                    d.line([(rng.randint(20, 60), y), (w - rng.randint(20, 80), y)], fill=(120, 120, 120), width=2)
                bx, by = rng.randint(40, w - 300), rng.randint(h // 2 + 20, h - 140)
                bw, bh = rng.randint(160, 260), rng.randint(50, 100)
                pts = [(bx + k * bw / 14, by + bh / 2 + rng.uniform(-bh / 2.2, bh / 2.2)) for k in range(15)]
                d.line(pts, fill=(10, 10, 80), width=3)
                labels = [f"0 {(bx + bw / 2) / w:.6f} {(by + bh / 2) / h:.6f} {bw / w:.6f} {bh / h:.6f}"]
                if i % 9 == 8:  # some negatives (no signature), like the real data
                    labels = []
                    img = Image.new("RGB", (w, h), (250, 250, 250))
                    ImageDraw.Draw(img).rectangle([30, 30, w - 30, 90], outline=(0, 0, 0))
                buf = io.BytesIO(); img.save(buf, format="JPEG", quality=90)
                z.writestr(f"reviewed_dataset/{split}/images/doc_{n:04d}.jpg", buf.getvalue())
                z.writestr(f"reviewed_dataset/{split}/labels/doc_{n:04d}.txt", "\n".join(labels) + ("\n" if labels else ""))
        if not dirty:
            return
        # deliberately dirty records: the cleaning stage must catch every one of them
        names = z.namelist()
        test_img = next(p for p in names if "/test/images/" in p)
        train_img = next(p for p in names if "/train/images/" in p)
        lbl = lambda p: p.replace("images", "labels").replace(".jpg", ".txt")  # noqa: E731
        z.writestr("reviewed_dataset/train/images/corrupt_0001.jpg", b"this is not a jpeg")
        z.writestr("reviewed_dataset/train/labels/corrupt_0001.txt", "0 0.5 0.5 0.2 0.1\n")
        z.writestr("reviewed_dataset/train/images/dup_of_train.jpg", z.read(train_img))
        z.writestr("reviewed_dataset/train/labels/dup_of_train.txt", z.read(lbl(train_img)))
        z.writestr("reviewed_dataset/train/images/leak_from_test.jpg", z.read(test_img))
        z.writestr("reviewed_dataset/train/labels/leak_from_test.txt", z.read(lbl(test_img)))
        buf = io.BytesIO(); Image.new("RGB", (600, 800), (250, 250, 250)).save(buf, format="JPEG")
        z.writestr("reviewed_dataset/train/images/bad_box.jpg", buf.getvalue())
        z.writestr("reviewed_dataset/train/labels/bad_box.txt", "0 1.40 0.50 0.30 0.10\n0 0.5 0.5 0.0 0.1\n")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("repo")
    ap.add_argument("--notebook", help="notebook already built by kaggle_job.py build (overrides cell filled in)")
    ap.add_argument("--dataset-zip", help="dataset ZIP to serve as the HF file (default: generate one)")
    ap.add_argument("--hf-commit", default="mockhfcommit0123456789")
    ap.add_argument("--bucket", default=os.environ.get("AWS_S3_BUCKET", "mock-models"))
    ap.add_argument("--evidence", default="/tmp/mock_e2e/evidence.json")
    a = ap.parse_args()

    repo = Path(a.repo).resolve()
    sys.path.insert(0, str(repo / "signature_service"))
    sys.path.insert(0, str(repo / "pipeline"))
    external_s3 = bool(os.environ.get("AWS_ENDPOINT_URL_S3"))
    for k, v in {"AWS_ACCESS_KEY_ID": "mock", "AWS_SECRET_ACCESS_KEY": "mock", "AWS_REGION": "us-east-1",
                 "AWS_DEFAULT_REGION": "us-east-1", "AWS_S3_BUCKET": a.bucket, "COMET_API_KEY": "mock",
                 "COMET_WORKSPACE": "mock-ws", "HF_TOKEN": "mock"}.items():
        os.environ.setdefault(k, v)

    work = Path("/tmp/mock_e2e")
    os.system(f"rm -rf {work}/published {work}/base {work}/hf /tmp/signature_ai_work")
    work.mkdir(parents=True, exist_ok=True)
    if a.dataset_zip:
        data_zip = Path(a.dataset_zip).resolve()
    else:
        data_zip = work / "hf" / "my_reviewed_export_nov10.zip"
        data_zip.parent.mkdir(parents=True, exist_ok=True)
        make_dataset_zip(data_zip)

    # ---------------------------------------------------------------- fake Hugging Face hub
    utc = datetime.timezone.utc
    hf_calls = []
    lfs_sha = sha256(data_zip)

    class FakeHfApi:
        def __init__(self, token=None):
            hf_calls.append(("HfApi", bool(token)))

        def repo_info(self, repo_id, repo_type=None, revision=None):
            hf_calls.append(("repo_info", repo_id, revision))
            return types.SimpleNamespace(sha=a.hf_commit)

        def list_repo_tree(self, repo_id, repo_type=None, revision=None, recursive=False, expand=False):
            hf_calls.append(("list_repo_tree", repo_id, revision))
            lc = lambda d: types.SimpleNamespace(date=d)  # noqa: E731
            return [types.SimpleNamespace(path="README.md", size=10, lfs=None, last_commit=lc(datetime.datetime(2026, 11, 10, 3, tzinfo=utc))),
                    types.SimpleNamespace(path="old_dataset_v1.zip", size=999, lfs=None, last_commit=lc(datetime.datetime(2026, 11, 1, tzinfo=utc))),
                    types.SimpleNamespace(path=data_zip.name, size=data_zip.stat().st_size,
                                          lfs=types.SimpleNamespace(sha256=lfs_sha, size=data_zip.stat().st_size),
                                          last_commit=lc(datetime.datetime(2026, 11, 10, 2, tzinfo=utc)))]

    def fake_hf_hub_download(repo_id, filename, repo_type=None, revision=None, token=None, local_dir=None):
        hf_calls.append(("download", repo_id, filename, revision))
        assert filename == data_zip.name, f"pipeline asked for the wrong ZIP: {filename}"
        return str(data_zip)

    import transformers  # noqa: F401  (import first so it binds the real hub functions)
    import huggingface_hub

    huggingface_hub.HfApi = FakeHfApi  # notebook does `from huggingface_hub import HfApi, hf_hub_download`
    huggingface_hub.hf_hub_download = fake_hf_hub_download

    # ---------------------------------------------------------------- Comet recorder
    comet_log = {"parameters": {}, "metrics": [], "assets": [], "images": [], "other": {}, "tags": [],
                 "remote_models": [], "ended": False}

    class FakeExperiment:
        url = "https://www.comet.com/mock-ws/signature-ai-detection/mock-experiment"

        def log_parameters(self, d): comet_log["parameters"].update(d)
        def log_metrics(self, d, step=None, epoch=None, **_): comet_log["metrics"].append((step, dict(d)))
        def log_asset(self, p, file_name=None, **_): comet_log["assets"].append(file_name or Path(p).name)
        def log_image(self, p, name=None, **_): comet_log["images"].append(name or Path(p).name)
        def log_other(self, k, v): comet_log["other"][k] = v
        def add_tag(self, t): comet_log["tags"].append(t)
        def log_remote_model(self, model_name, uri, **_): comet_log["remote_models"].append((model_name, uri))
        def get_key(self): return "mock-experiment-key"
        def end(self): comet_log["ended"] = True

    def fake_comet_start(**kw):
        comet_log["tags"] += list(kw.get("experiment_config").tags)
        comet_log["project"] = kw.get("project_name")
        return FakeExperiment()

    sys.modules["comet_ml"] = types.SimpleNamespace(start=fake_comet_start,
                                                    ExperimentConfig=lambda **kw: types.SimpleNamespace(**kw))

    # ---------------------------------------------------------------- S3 with a served model behind aliases/latest.json
    mock = None
    if not external_s3:
        from moto import mock_aws

        mock = mock_aws()
        mock.start()
    import boto3
    from tests.helpers import build_tiny_model, publish_version

    s3 = boto3.client("s3", region_name="us-east-1")
    try:
        s3.create_bucket(Bucket=a.bucket)
    except Exception:
        pass
    try:
        s3.head_object(Bucket=a.bucket, Key="signatureai/detection/aliases/latest.json")
    except Exception:
        publish_version(s3, a.bucket, "signatureai/detection", "v-served-champion", work / "published", seed=3)
    base_model_dir = build_tiny_model(work / "base", "base")  # stands in for PekingU/rtdetr_v2_r18vd

    # ---------------------------------------------------------------- the notebook, with the CPU-only patches
    import kaggle_job

    nb_path = Path(a.notebook) if a.notebook else repo / "pipeline" / "train_pipeline.ipynb"
    nb = json.loads(nb_path.read_text())
    standalone = types.SimpleNamespace(
        mode="smoke", hf_repo="mabdullahkhalid/Signature_Dataset_Detection", hf_zip="auto", hf_revision="main",
        no_deploy=False, deploy_alias="latest", gate_floor=0.0, gate_max_regression=1.0,
        github_run_url="https://github.com/mock/run")
    cpu_patches = [
        ("assert torch.cuda.is_available(), 'Training RT-DETRv2 realistically requires a GPU. In Colab: Runtime > Change runtime type > T4 GPU.'", "pass  # MOCK: CPU run"),
        ("device=torch.device('cuda'); torch.manual_seed(SEED); torch.cuda.manual_seed_all(SEED)", "device=torch.device('cpu'); torch.manual_seed(SEED)"),
        ("gpu_name = torch.cuda.get_device_name(0)", "gpu_name = 'MOCK-CPU T4'"),
        ("gpu_total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3", "gpu_total_gb = 16.0"),
        ("torch.cuda.reset_peak_memory_stats(device)", "pass"),
        ("round(torch.cuda.max_memory_allocated(device) / 1024**3, 2)", "0.0"),
        ("round(torch.cuda.max_memory_allocated(device)/1024**3, 2)", "0.0"),
        ("MODEL_ID = 'PekingU/rtdetr_v2_r18vd'", f"MODEL_ID = {str(base_model_dir)!r}  # MOCK: local tiny RT-DETRv2"),
        ("plt.show()", "plt.close('all')"),
    ]
    cells = []
    for c in nb["cells"]:
        if c["cell_type"] != "code":
            continue
        src = "".join(c["source"])
        if src.startswith("# PIPELINE OVERRIDES"):
            if not a.notebook:
                src = kaggle_job.overrides_cell(standalone) + "GATE_MIN_TEST_MAP50 = 0.0\n"
            src += "\n# MOCK (CPU): small batches, no worker processes\nBATCH_SIZE = 4\nNUM_WORKERS = 0\n"
        src = "\n".join(line for line in src.splitlines() if not line.lstrip().startswith(("%", "!")))
        for old, new in cpu_patches:
            src = src.replace(old, new)
        cells.append(src)

    ns = {"__name__": "__main__", "display": lambda x: print(x.to_string() if hasattr(x, "to_string") else x)}
    timeline, failed = [], False
    for i, src in enumerate(cells):
        title = next((line for line in src.splitlines() if line.strip() and not line.startswith("live_")), "(empty)")[:70]
        t0 = time.time()
        print(f"\n######## [{i:02d}] {title}", flush=True)
        try:
            exec(compile(src, f"cell_{i}", "exec"), ns)
        except Exception:
            import traceback

            traceback.print_exc()
            timeline.append((i, title, "FAILED", round(time.time() - t0, 1)))
            failed = True
            break
        timeline.append((i, title, "ok", round(time.time() - t0, 1)))

    print("\n\n================ MOCK RUN TIMELINE ================")
    for i, title, status, secs in timeline:
        print(f"{i:02d} {status:6} {secs:6.1f}s  {title}")
    reports = Path("/tmp/signature_ai_work/run/reports")
    alias = None
    try:
        alias = json.loads(s3.get_object(Bucket=a.bucket, Key="signatureai/detection/aliases/latest.json")["Body"].read())
    except Exception:
        pass
    evidence = {
        "hf_calls": hf_calls,
        "s3_objects": sorted(o["Key"] for o in s3.list_objects_v2(Bucket=a.bucket).get("Contents", [])),
        "latest_alias": alias,
        "comet": {"project": comet_log.get("project"), "tags": comet_log["tags"], "n_parameters": len(comet_log["parameters"]),
                  "metric_names": sorted({k for _, d in comet_log["metrics"] for k in d}), "assets": comet_log["assets"],
                  "other": comet_log["other"], "remote_models": comet_log["remote_models"], "ended": comet_log["ended"]},
        "pipeline_result": ns.get("PIPELINE_RESULT"),
        "reports": sorted(p.name for p in reports.glob("*")) if reports.exists() else [],
    }
    Path(a.evidence).parent.mkdir(parents=True, exist_ok=True)
    Path(a.evidence).write_text(json.dumps(evidence, indent=2, default=str))
    print(json.dumps({k: evidence[k] for k in ("latest_alias", "pipeline_result")}, indent=2, default=str)[:3000])
    if mock:
        mock.stop()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
