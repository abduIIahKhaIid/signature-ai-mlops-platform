"""Mock end-to-end run of pipeline/train_pipeline.ipynb.

Executes the REAL notebook cells in order (same code Kaggle runs) with only the outside world replaced:
  Hugging Face  -> synthetic YOLO dataset ZIP + fake HfApi / hf_hub_download
  Amazon S3     -> moto (in-process), pre-loaded with a served model behind aliases/latest.json (warm start + champion)
  Comet         -> recorder that keeps every parameter / metric / asset the notebook logs
  GPU           -> CPU, tiny randomly initialised RT-DETRv2 (same architecture family, no download)
Usage: python run_mock_pipeline.py <repo_root>
"""
from __future__ import annotations

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
REPO = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(REPO / "signature_service"))
sys.path.insert(0, str(REPO / "pipeline"))

for k, v in {"AWS_ACCESS_KEY_ID": "mock", "AWS_SECRET_ACCESS_KEY": "mock", "AWS_REGION": "us-east-1",
             "AWS_DEFAULT_REGION": "us-east-1", "AWS_S3_BUCKET": "mock-models", "COMET_API_KEY": "mock",
             "COMET_WORKSPACE": "mock-ws", "HF_TOKEN": "mock"}.items():
    os.environ[k] = v

from PIL import Image, ImageDraw  # noqa: E402

WORK = Path("/tmp/mock_e2e")
os.system(f"rm -rf {WORK} /tmp/signature_ai_work")
WORK.mkdir(parents=True)


# ------------------------------------------------------------------ synthetic dataset ZIP (YOLO, like the dashboard)
def make_dataset_zip(path: Path, counts={"train": 48, "valid": 12, "test": 12}) -> None:
    rng = random.Random(7)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("reviewed_dataset/data.yaml", "path: .\ntrain: train/images\nval: valid/images\ntest: test/images\nnc: 1\nnames:\n- signature\n")
        n = 0
        for split, count in counts.items():
            for i in range(count):
                n += 1
                w, h = rng.randint(500, 800), rng.randint(600, 900)
                img = Image.new("RGB", (w, h), (rng.randint(235, 255),) * 3)
                d = ImageDraw.Draw(img)
                for y in range(rng.randint(30, 80), h // 2, rng.randint(22, 40)):   # printed text lines
                    d.line([(rng.randint(20, 60), y), (w - rng.randint(20, 80), y)], fill=(120, 120, 120), width=2)
                bx, by = rng.randint(40, w - 300), rng.randint(h // 2 + 20, h - 140)
                bw, bh = rng.randint(160, 260), rng.randint(50, 100)
                pts = [(bx + k * bw / 14, by + bh / 2 + rng.uniform(-bh / 2.2, bh / 2.2)) for k in range(15)]
                d.line(pts, fill=(10, 10, 80), width=3)
                labels = [] if i % 9 == 8 else [f"0 {(bx + bw / 2) / w:.6f} {(by + bh / 2) / h:.6f} {bw / w:.6f} {bh / h:.6f}"]
                if i % 9 == 8:   # some negatives (no signature), like the real data
                    img = Image.new("RGB", (w, h), (250, 250, 250)); ImageDraw.Draw(img).rectangle([30, 30, w - 30, 90], outline=(0, 0, 0))
                buf = io.BytesIO(); img.save(buf, format="JPEG", quality=90)
                z.writestr(f"reviewed_dataset/{split}/images/doc_{n:04d}.jpg", buf.getvalue())
                z.writestr(f"reviewed_dataset/{split}/labels/doc_{n:04d}.txt", "\n".join(labels) + ("\n" if labels else ""))
        # ---- deliberately dirty records: the cleaning stage must catch every one of them
        names = z.namelist()
        test_img = next(p for p in names if "/test/images/" in p)
        train_img = next(p for p in names if "/train/images/" in p)
        z.writestr("reviewed_dataset/train/images/corrupt_0001.jpg", b"this is not a jpeg")                      # corrupt image
        z.writestr("reviewed_dataset/train/labels/corrupt_0001.txt", "0 0.5 0.5 0.2 0.1\n")
        z.writestr("reviewed_dataset/train/images/dup_of_train.jpg", z.read(train_img))                          # exact duplicate
        z.writestr("reviewed_dataset/train/labels/dup_of_train.txt", z.read(train_img.replace("images", "labels").replace(".jpg", ".txt")))
        z.writestr("reviewed_dataset/train/images/leak_from_test.jpg", z.read(test_img))                         # test image copied into train
        z.writestr("reviewed_dataset/train/labels/leak_from_test.txt", z.read(test_img.replace("images", "labels").replace(".jpg", ".txt")))
        buf = io.BytesIO(); Image.new("RGB", (600, 800), (250, 250, 250)).save(buf, format="JPEG")
        z.writestr("reviewed_dataset/train/images/bad_box.jpg", buf.getvalue())                                   # box outside the image
        z.writestr("reviewed_dataset/train/labels/bad_box.txt", "0 1.40 0.50 0.30 0.10\n0 0.5 0.5 0.0 0.1\n")


DATA_ZIP = WORK / "hf" / "my_reviewed_export_nov10.zip"
DATA_ZIP.parent.mkdir(parents=True)
make_dataset_zip(DATA_ZIP)

# ------------------------------------------------------------------ fake Hugging Face hub
UTC = __import__("datetime").timezone.utc
_dt = __import__("datetime").datetime
hf_calls = []


class FakeHfApi:
    def __init__(self, token=None):
        hf_calls.append(("HfApi", bool(token)))

    def repo_info(self, repo_id, repo_type=None, revision=None):
        hf_calls.append(("repo_info", repo_id, revision))
        return types.SimpleNamespace(sha="mockhfcommit0123456789")

    def list_repo_tree(self, repo_id, repo_type=None, revision=None, recursive=False, expand=False):
        hf_calls.append(("list_repo_tree", repo_id, revision))
        lc = lambda d: types.SimpleNamespace(date=d)  # noqa: E731
        return [types.SimpleNamespace(path="README.md", size=10, last_commit=lc(_dt(2026, 11, 10, 3, tzinfo=UTC))),
                types.SimpleNamespace(path="old_dataset_v1.zip", size=999, last_commit=lc(_dt(2026, 11, 1, tzinfo=UTC))),
                types.SimpleNamespace(path=DATA_ZIP.name, size=DATA_ZIP.stat().st_size, last_commit=lc(_dt(2026, 11, 10, 2, tzinfo=UTC)))]


def fake_hf_hub_download(repo_id, filename, repo_type=None, revision=None, token=None, local_dir=None):
    hf_calls.append(("download", repo_id, filename, revision))
    assert filename == DATA_ZIP.name, f"pipeline asked for the wrong ZIP: {filename}"
    return str(DATA_ZIP)


import transformers  # noqa: E402,F401  (import first so it binds the real hub functions)
import huggingface_hub  # noqa: E402

huggingface_hub.HfApi = FakeHfApi                 # notebook does `from huggingface_hub import HfApi, hf_hub_download`
huggingface_hub.hf_hub_download = fake_hf_hub_download

# ------------------------------------------------------------------ Comet recorder
comet_log = {"parameters": {}, "metrics": [], "assets": [], "images": [], "other": {}, "tags": [], "remote_models": [], "ended": False}


class FakeExperiment:
    url = "https://www.comet.com/mock-ws/signature-ai-detection/mock-experiment"
    alive, ended = True, False

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


sys.modules["comet_ml"] = types.SimpleNamespace(start=fake_comet_start, ExperimentConfig=lambda **kw: types.SimpleNamespace(**kw))

# ------------------------------------------------------------------ S3 (moto) with a served model behind aliases/latest.json
from moto import mock_aws  # noqa: E402

mock = mock_aws()
mock.start()
import boto3  # noqa: E402
from tests.helpers import build_tiny_model, publish_version  # noqa: E402

s3 = boto3.client("s3", region_name="us-east-1")
s3.create_bucket(Bucket="mock-models")
publish_version(s3, "mock-models", "signatureai/detection", "v-served-champion", WORK / "published", seed=3)
BASE_MODEL_DIR = build_tiny_model(WORK / "base", "base")   # stands in for PekingU/rtdetr_v2_r18vd (no download)

# ------------------------------------------------------------------ the notebook, with the CPU-only patches
import kaggle_job  # noqa: E402

nb = json.loads((REPO / "pipeline" / "train_pipeline.ipynb").read_text())
args = types.SimpleNamespace(mode="smoke", hf_repo="mabdullahkhalid/Signature_Dataset_Detection", hf_zip="auto",
                             hf_revision="main", no_deploy=False, deploy_alias="latest", gate_floor=0.0,
                             gate_max_regression=1.0, github_run_url="https://github.com/mock/run")
CPU_PATCHES = [
    ("assert torch.cuda.is_available(), 'Training RT-DETRv2 realistically requires a GPU. In Colab: Runtime > Change runtime type > T4 GPU.'", "pass  # MOCK: CPU run"),
    ("device=torch.device('cuda'); torch.manual_seed(SEED); torch.cuda.manual_seed_all(SEED)", "device=torch.device('cpu'); torch.manual_seed(SEED)"),
    ("gpu_name = torch.cuda.get_device_name(0)", "gpu_name = 'MOCK-CPU T4'"),
    ("gpu_total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3", "gpu_total_gb = 16.0"),
    ("torch.cuda.reset_peak_memory_stats(device)", "pass"),
    ("round(torch.cuda.max_memory_allocated(device) / 1024**3, 2)", "0.0"),
    ("round(torch.cuda.max_memory_allocated(device)/1024**3, 2)", "0.0"),
    ("MODEL_ID = 'PekingU/rtdetr_v2_r18vd'", f"MODEL_ID = {str(BASE_MODEL_DIR)!r}  # MOCK: local tiny RT-DETRv2"),
    ("plt.show()", "plt.close('all')"),
]
cells = []
for c in nb["cells"]:
    if c["cell_type"] != "code":
        continue
    src = "".join(c["source"])
    if src.startswith("# PIPELINE OVERRIDES"):
        src = kaggle_job.overrides_cell(args) + "\nBATCH_SIZE = 4\nNUM_WORKERS = 0\nGATE_MIN_TEST_MAP50 = 0.0\n"
    src = "\n".join(l for l in src.splitlines() if not l.lstrip().startswith(("%", "!")))
    for old, new in CPU_PATCHES:
        src = src.replace(old, new)
    cells.append(src)

ns = {"__name__": "__main__", "display": lambda x: print(x.to_string() if hasattr(x, "to_string") else x)}
timeline = []
for i, src in enumerate(cells):
    title = src.strip().splitlines()[0][:70] if src.strip() else "(empty)"
    t0 = time.time()
    print(f"\n######## [{i:02d}] {title}", flush=True)
    try:
        exec(compile(src, f"cell_{i}", "exec"), ns)
    except Exception:
        import traceback
        traceback.print_exc()
        timeline.append((i, title, "FAILED", round(time.time() - t0, 1)))
        break
    timeline.append((i, title, "ok", round(time.time() - t0, 1)))

# ------------------------------------------------------------------ evidence
print("\n\n================ MOCK RUN TIMELINE ================")
for i, title, status, secs in timeline:
    print(f"{i:02d} {status:6} {secs:6.1f}s  {title}")
evidence = {
    "hf_calls": hf_calls,
    "s3_objects": sorted(o["Key"] for o in s3.list_objects_v2(Bucket="mock-models").get("Contents", [])),
    "latest_alias": json.loads(s3.get_object(Bucket="mock-models", Key="signatureai/detection/aliases/latest.json")["Body"].read()),
    "comet": {"project": comet_log.get("project"), "tags": comet_log["tags"], "n_parameters": len(comet_log["parameters"]),
              "parameters_sample": {k: comet_log["parameters"].get(k) for k in ("run_version", "pipeline_mode", "init_version", "hf_zip_filename", "hf_dataset_commit", "dataset_sha256", "epochs", "batch_size")},
              "metric_names": sorted({k for _, d in comet_log["metrics"] for k in d}), "assets": comet_log["assets"],
              "images": comet_log["images"], "other": comet_log["other"], "remote_models": comet_log["remote_models"], "ended": comet_log["ended"]},
    "pipeline_result": ns.get("PIPELINE_RESULT"),
    "reports": sorted(p.name for p in (Path("/tmp/signature_ai_work/run/reports")).glob("*")) if Path("/tmp/signature_ai_work/run/reports").exists() else [],
}
(WORK / "evidence.json").write_text(json.dumps(evidence, indent=2, default=str))
print(json.dumps(evidence, indent=2, default=str))
mock.stop()
