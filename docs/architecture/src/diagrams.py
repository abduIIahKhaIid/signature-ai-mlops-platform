"""The SignatureAI architecture diagrams. python diagrams.py <out_dir> writes page fragments + standalone SVGs."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from svgkit import Svg

ACC = "accent"


# =========================================================================== 1. system architecture
def architecture(mode):
    s = Svg(1240, 805, "System architecture: clients, EC2 containers, S3, Hugging Face, Kaggle, Comet, Logfire, GitHub Actions", mode)
    s._markers = set()
    # external row
    s.box(30, 40, 190, 95, "Annotator (local PC)", ["dataset_dashboard (Node.js)", "review boxes, export ZIP"], "ext", "ext-line")
    s.box(290, 40, 220, 95, "Hugging Face dataset", ["mabdullahkhalid/", "Signature_Dataset_Detection", "reviewed ZIPs (Git LFS)"], "ext", "ext-line")
    s.box(650, 40, 250, 95, "Kaggle notebook · T4 GPU", ["kernel signatureai-retrain", "clean → fine-tune RT-DETRv2", "→ evaluate → validation gate"], "ext", "ext-line")
    s.box(990, 40, 225, 95, "Comet", ["workspace abdullah-khalid", "signature-ai-detection-retrain", "metrics · params · files"], "ext", "ext-line")
    s.arrow([(220, 88), (290, 88)], "publish", at=(255, 80), color=ACC)
    s.arrow([(650, 70), (510, 70)], "download pinned ZIP", at=(580, 62), color=ACC)
    s.arrow([(900, 88), (990, 88)], "log run", at=(945, 80), color=ACC)

    # EC2
    s.frame(260, 200, 650, 548, "AWS EC2 · Sydney (ap-southeast-2)", sub="docker compose: redis, api, worker, pipeline (+ caddy)", bottom=True)
    s.box(280, 285, 130, 70, "caddy", ["HTTPS :443", "optional"])
    s.box(445, 255, 215, 135, "api", ["/v1/detect · /v1/verify", "/v1/jobs/{id} · /v1/model", "/webhooks/huggingface", "/pipeline (React web app)", "rate limit 30 jobs/min/IP"], tag="FastAPI :8000")
    s.box(690, 255, 200, 135, "pipeline", ["queue 'pipeline' + beat 15 s", "orchestrator: dedup, push,", "monitor, stop, rollback,", "alerts, epochs setting", "reads Comet REST API"], tag="Celery")
    s.box(280, 430, 130, 66, "uploads", ["/data/uploads"], mono_sub=True, tag="volume")
    s.box(445, 430, 445, 66, "redis", ["broker db0 · results db1 · pipeline:* run state · rate-limit counters"], tag="7-alpine")
    s.box(445, 560, 215, 135, "worker", ["RT-DETRv2 detector", "Siamese ResNet18 similarity", "hot reload: polls the alias", "every 300 s, loads, swaps", "model cache volume"], tag="Celery")

    # clients + CI
    s.box(30, 285, 190, 70, "Browser / API client", ["web app, curl, Locust"])
    s.arrow([(220, 320), (280, 320)], "HTTPS", at=(250, 312))
    s.arrow([(410, 320), (445, 320)])
    s.box(30, 600, 190, 95, "GitHub Actions", ["CI on every push", "CD on main: AWS SSM →", "remote_deploy.sh"], "ext", "ext-line")
    s.arrow([(220, 648), (260, 648)], dash=True)

    # request path
    s.arrow([(445, 372), (378, 372), (378, 430)], "image bytes", at=(372, 404), anchor="end")
    s.arrow([(552, 390), (552, 430)], "enqueue job key", at=(560, 414), anchor="start")
    s.arrow([(552, 496), (552, 560)], "deliver job", at=(560, 532), anchor="start")
    s.arrow([(445, 625), (335, 625), (335, 496)], "read image", at=(343, 560), anchor="start")
    s.arrow([(790, 390), (790, 430)], "queue + run state", at=(798, 414), anchor="start", color=ACC, both=True)

    # retraining path across the frame
    s.arrow([(470, 135), (470, 255)], ["webhook POST", "(X-Webhook-Secret)"], at=(462, 163), anchor="end", color=ACC)
    s.arrow([(705, 255), (705, 165), (495, 165), (495, 135)], "list ZIPs + SHA-256", at=(600, 158), color=ACC)
    s.arrow([(775, 255), (775, 135)], ["sync secrets,", "push notebook version"], at=(783, 168), anchor="start", color=ACC)

    # S3 + Logfire
    s.box(980, 255, 235, 340, "Amazon S3", [], "s3", "s3-line")
    s.text(992, 294, "signatureai-df-detr-models", size=11.5, color="muted")
    s.lines(992, 318, ["detection/", "  versions/<v>/artifact.zip", "  versions/<v>/manifest.json", "  aliases/latest.json",
                       "  checkpoints/<v>/", "  pipeline_runs/live/<run>", "  pipeline_runs/datasets/<sha>", "  pipeline_runs/control/<run>",
                       "similarity/", "  aliases/latest.json", "  versions/<v>/*.pt"], size=11, gap=15.5, mono=True, color="ink")
    s.lines(992, 506, ["Kaggle writes versions, alias, live", "EC2 pipeline writes stop, rollback", "workers read the alias"], size=11, color="muted", gap=15)
    s.text(992, 578, "versions immutable · aliases move", size=11, color="muted", italic=True)
    s.arrow([(880, 135), (880, 160), (1100, 160), (1100, 255)], None, color=ACC)
    s.lines(1092, 182, ["model version + manifest", "live progress every 20 s", "alias, if the gate passes"], size=11, color=ACC, anchor="end", gap=14)
    s.arrow([(890, 300), (980, 300)], ["read progress", "stop · rollback"], at=(935, 322), color=ACC, both=True)
    s.arrow([(660, 585), (980, 585)], "fetch model by alias (SHA-256 checked)", at=(820, 577))
    s.box(980, 625, 235, 70, "Logfire", ["request → queue wait → inference"], "ext", "ext-line")
    s.arrow([(660, 660), (980, 660)], "traces + logs (api, worker)", at=(820, 652))

    # legend
    y = 782
    s.arrow([(260, y), (300, y)])
    s.text(308, y + 4, "inference request and model loading", size=11.5, color="muted")
    s.arrow([(540, y), (580, y)], color=ACC)
    s.text(588, y + 4, "continuous training (dataset → model)", size=11.5, color="muted")
    s.arrow([(830, y), (870, y)], dash=True)
    s.text(878, y + 4, "code deploy (CI/CD)", size=11.5, color="muted")
    return s


# =========================================================================== sequence helper
def sequence(mode, label, lanes, steps, width, height, lane_w=140):
    """lanes: [(key, title, sub, zone)], steps: list of dicts."""
    s = Svg(width, height, label, mode)
    s._markers = set()
    xs = {}
    n = len(lanes)
    gap = (width - 40) / n
    for i, (key, title, sub, zone) in enumerate(lanes):
        x = 20 + gap * i + gap / 2
        xs[key] = x
        fill, stroke = {"ec2": ("ec2", "ec2-line"), "ext": ("ext", "ext-line"), "s3": ("s3", "s3-line")}.get(zone, ("surface", "line"))
        s.parts.append(f'<line x1="{x}" y1="70" x2="{x}" y2="{height - 16}" style="stroke:{s.c("line")};stroke-width:1.2;stroke-dasharray:4 4"/>')
        s.box(x - lane_w / 2, 16, lane_w, 54, title, [sub] if sub else [], fill, stroke, center=True)
    num = 0
    for st in steps:
        kind = st.get("kind", "msg")
        y = st["y"]
        if kind == "loop":
            x0, x1 = xs[st["from"]] - st.get("pad", 70), xs[st["to"]] + st.get("pad", 70)
            s.rect(x0, y, x1 - x0, st["h"], "bg", "line", rx=6, dash=True)
            s.rect(x0, y, len(st["text"]) * 6.3 + 16, 20, "line", "line", rx=6)
            s.text(x0 + 8, y + 14, st["text"], size=11, weight=600, color="ink")
            continue
        if kind == "note":
            x = xs[st["at"]]
            w = st.get("w", 220)
            s.rect(x - w / 2, y - 14, w, 22 + 14 * (len(st["text"]) - 1), st.get("fill", "accent-soft"), st.get("stroke", "accent"), rx=5, sw=1)
            s.lines(x, y + 1, st["text"], size=11, color="ink", anchor="middle", gap=14)
            continue
        num += 1
        a, b = xs[st["from"]], xs[st["to"]]
        color = st.get("color", "ink")
        right = b > a
        s.arrow([(a + (6 if right else -6), y), (b + (-6 if right else 6), y)], st["text"],
                at=(a + 10 if right else a - 10, y - 7), anchor="start" if right else "end",
                color=color, dash=kind == "reply", lcolor="ink")
        s.number(a + (-14 if b > a else 14), y, num, "accent" if color == "accent" else "muted")
    return s


# =========================================================================== 2. inference request
def inference(mode):
    lanes = [("client", "Client", "browser / curl", "plain"), ("api", "api", "FastAPI", "ec2"),
             ("up", "uploads", "shared volume", "ec2"), ("redis", "redis", "broker + results", "ec2"),
             ("worker", "worker", "Celery, RT-DETRv2", "ec2")]
    st = [
        dict(y=108, **{"from": "client", "to": "api"}, text="POST /v1/detect  (image, threshold, wait)"),
        dict(y=150, **{"from": "api", "to": "redis"}, text="count request: 30 jobs/min per IP"),
        dict(y=192, **{"from": "api", "to": "up"}, text="write image bytes → key"),
        dict(y=234, **{"from": "api", "to": "redis"}, text="enqueue detect(key, threshold)"),
        dict(y=276, **{"from": "api", "to": "client"}, text="202 {job_id}   (wait=true: holds until done)", kind="reply"),
        dict(y=318, **{"from": "redis", "to": "worker"}, text="deliver task"),
        dict(y=360, **{"from": "worker", "to": "up"}, text="read image, delete after use"),
        dict(y=398, kind="note", at="worker", w=230, text=["RT-DETRv2 inference (CPU)", "keep boxes ≥ calibrated threshold"]),
        dict(y=446, **{"from": "worker", "to": "redis"}, text="store result in db1"),
        dict(y=488, **{"from": "client", "to": "api"}, text="GET /v1/jobs/{job_id}"),
        dict(y=530, **{"from": "api", "to": "redis"}, text="read result"),
        dict(y=572, **{"from": "api", "to": "client"}, text="200 boxes, scores, model version", kind="reply"),
    ]
    return sequence(mode, "Detection request: API stores the image, queues a small job key, a Celery worker runs RT-DETRv2 and stores the result",
                    lanes, st, 1000, 600, lane_w=150)


# =========================================================================== 3. continuous training
def retraining(mode):
    lanes = [("ann", "Annotator", "dataset dashboard", "ext"), ("hf", "Hugging Face", "dataset repo", "ext"),
             ("api", "api", "EC2", "ec2"), ("pipe", "pipeline", "EC2 orchestrator", "ec2"),
             ("kg", "Kaggle", "T4 notebook", "ext"), ("s3", "Amazon S3", "registry + runs", "s3"),
             ("comet", "Comet", "experiments", "ext"), ("wk", "workers", "EC2 inference", "ec2")]
    A = "accent"
    st = [
        dict(y=104, **{"from": "ann", "to": "hf"}, text="upload reviewed ZIP", color=A),
        dict(y=142, **{"from": "hf", "to": "api"}, text="webhook (secret checked)", color=A),
        dict(y=180, **{"from": "api", "to": "pipe"}, text="pipeline.check via Redis, 45 s debounce", color=A),
        dict(y=218, **{"from": "pipe", "to": "hf"}, text="newest ZIP + commit + SHA-256"),
        dict(y=256, **{"from": "pipe", "to": "s3"}, text="datasets/<sha>.json exists?"),
        dict(y=290, kind="note", at="s3", w=200, text=["yes → skip: already trained"], fill="bg", stroke="line"),
        dict(y=330, **{"from": "pipe", "to": "comet"}, text="preflight: API key + workspace"),
        dict(y=368, **{"from": "pipe", "to": "kg"}, text="sync secrets · push version (commit + SHA pinned)", color=A),
        dict(y=406, **{"from": "kg", "to": "hf"}, text="download ZIP, verify SHA-256"),
        dict(y=440, kind="note", at="kg", w=250, text=["clean · near-dup · leakage gate · split"]),
        dict(y=480, **{"from": "kg", "to": "s3"}, text="load served model (warm start)"),
        dict(y=508, kind="loop", **{"from": "pipe", "to": "comet"}, h=150, text="while training: every epoch / every 20 s", pad=60),
        dict(y=552, **{"from": "kg", "to": "comet"}, text="metrics per epoch"),
        dict(y=590, **{"from": "kg", "to": "s3"}, text="write live/<run>.json · read control/<run>.json"),
        dict(y=628, **{"from": "pipe", "to": "s3"}, text="read live progress every 15 s · Stop writes control"),
        dict(y=690, kind="note", at="kg", w=270, text=["test evaluation · threshold calibration", "validation gate vs served model"]),
        dict(y=744, **{"from": "kg", "to": "s3"}, text="versions/<v> + manifest · alias if passed", color=A),
        dict(y=782, **{"from": "wk", "to": "s3"}, text="poll alias every 300 s → load → swap", color=A),
        dict(y=820, **{"from": "pipe", "to": "wk"}, text="model_info: serving <v>? → run succeeded"),
    ]
    return sequence(mode, "Continuous training: a dataset upload on Hugging Face triggers the EC2 orchestrator, which trains on Kaggle and deploys through the S3 alias",
                    lanes, st, 1240, 850, lane_w=136)


# =========================================================================== 4. CI/CD
def cicd(mode):
    s = Svg(1240, 470, "CI/CD: tests and image builds on GitHub Actions, then deploy on EC2 through AWS SSM with containers rebuilt one at a time", mode)
    s._markers = set()
    s.box(20, 185, 130, 70, "git push", ["branch main"], "ext", "ext-line")
    s.frame(185, 40, 470, 390, "GitHub Actions · ci-cd.yml", fill="ext", stroke="ext-line", sub="ubuntu-latest runners")
    jobs = [("service-tests", "pytest + real Redis/Celery, pyflakes"), ("dashboard-tests", "node --test (dataset dashboard)"),
            ("web-app", "tsc + vite build (React)"), ("pipeline-checks", "notebook in sync, flat pyflakes,")]
    for i, (n, d) in enumerate(jobs):
        y = 90 + i * 80
        sub = [d] + (["Kaggle job dry-run build"] if n == "pipeline-checks" else [])
        s.box(205, y, 220, 62 if n != "pipeline-checks" else 66, n, sub)
        s.arrow([(150, 220), (178, 220), (178, y + 31), (205, y + 31)])
    s.box(455, 90, 180, 62, "docker-build", ["api · worker · pipeline"])
    s.arrow([(425, 121), (455, 121)], None)
    s.box(455, 250, 180, 160, "deploy", ["needs all 5 jobs", "only on main", "only if signature_service/", "or pipeline/ changed", "only if AWS secrets set", "", ""], "surface", "accent")
    s.lines(467, 390, ["deploy-only IAM user"], size=11, color="accent")
    for i in range(4):
        y = 121 + i * 80
        s.arrow([(425, y), (440, y), (440, 330), (455, 330)])
    s.arrow([(545, 152), (545, 250)])
    # EC2
    s.arrow([(635, 330), (725, 330)], ["AWS SSM", "send-command"], at=(680, 300), dash=True)
    s.frame(725, 40, 495, 390, "EC2 · /home/ubuntu/app", sub=".env is untracked and kept · volumes kept")
    steps = [("git fetch + reset --hard <sha>", ""),
             ("1  docker compose down", "stop old containers first (frees RAM)"),
             ("2  prune images + build cache", "dangling images, cache older than 72 h"),
             ("3  build api → worker → pipeline", "one image at a time (torch is heavy)"),
             ("4  docker compose up -d", "+ caddy if PUBLIC_HOST is set"),
             ("wait for /ready, /health = <sha>", "fail the deploy after 5 min")]
    for i, (t, d) in enumerate(steps):
        y = 92 + i * 52
        s.rect(745, y, 455, 42, "surface", "line", rx=6)
        s.text(759, y + 18, t, size=12.5, weight=600, mono=True)
        if d:
            s.text(759, y + 34, d, size=11, color="muted")
        if i:
            s.arrow([(972, y - 10), (972, y)])
    s.text(745, 420, "then GitHub checks the public URL: /health and /ready", size=11.5, color="muted")
    return s


# =========================================================================== 5. run lifecycle
def lifecycle(mode):
    s = Svg(1240, 540, "Run lifecycle: decisions that start no run, then running, and the final states a run can end in", mode)
    s._markers = set()
    s.box(20, 60, 200, 110, "Triggers", ["HF webhook", "poll every 30 min (fallback)", "Check for new data", "Retrain anyway (force)"], "ext", "ext-line")
    s.box(270, 60, 210, 110, "pipeline.check", ["read newest ZIP on HF", "compare SHA-256 with", "trained-dataset markers", "Comet + Kaggle preflight"], "surface", "accent")
    s.arrow([(220, 115), (270, 115)])
    # no-run outcomes
    s.frame(20, 220, 460, 270, "Decisions without a run (\"Why runs started or not\")", fill="bg", stroke="line")
    outs = [("no_dataset", "no .zip in the repo"), ("skipped_trained", "same SHA-256 already trained"),
            ("deferred", "a run is active: re-check after it"), ("blocked", "Kaggle or Comet not configured"),
            ("skipped_failed", "failed 2 times: not auto-retried"), ("error", "HF or S3 unreachable")]
    for i, (k, d) in enumerate(outs):
        y = 262 + i * 36
        s.rect(40, y, 150, 26, "surface", "line", rx=13)
        s.text(115, y + 17, k, size=11.5, weight=600, anchor="middle", mono=True)
        s.text(204, y + 17, d, size=11.5, color="muted")
    s.arrow([(375, 170), (375, 220)], "no run", at=(383, 200), anchor="start")
    # running
    s.rect(560, 85, 170, 60, "accent-soft", "accent", rx=30)
    s.text(645, 112, "running", size=14, weight=700, anchor="middle", color="accent", mono=True)
    s.text(645, 130, "Kaggle job + monitor", size=11, anchor="middle", color="muted")
    s.arrow([(480, 115), (560, 115)], "started", at=(520, 107))
    finals = [("failed", "bad", "Kaggle error or timeout", "counts toward retry limit"),
              ("stopped", "bad", "Stop button, before the gate", "dataset can run again"),
              ("rejected", "warn", "gate failed", "version kept, alias unchanged"),
              ("approved", "warn", "gate passed, AUTO_DEPLOY off", "alias unchanged")]
    for i, (k, tone, why, after) in enumerate(finals):
        y = 210 + i * 70
        s.rect(560, y, 170, 50, "surface", tone, rx=25)
        s.text(645, y + 30, k, size=13, weight=700, anchor="middle", color=tone, mono=True)
        s.arrow([(610, 145), (610, y)] if i == 0 else [(585, 145), (585, 180), (545, 180), (545, y + 25), (560, y + 25)], None)
        s.text(745, y + 21, why, size=11.5, color="ink")
        s.text(745, y + 37, after, size=11, color="muted")
    s.arrow([(730, 115), (900, 115)], ["gate passed,", "alias moved"], at=(815, 92))
    s.rect(900, 85, 170, 60, "accent-soft", "accent", rx=30)
    s.text(985, 112, "deploying", size=14, weight=700, anchor="middle", color="accent", mono=True)
    s.text(985, 130, "waiting for hot reload", size=11, anchor="middle", color="muted")
    s.rect(900, 220, 170, 50, "surface", "good", rx=25)
    s.text(985, 250, "succeeded", size=13, weight=700, anchor="middle", color="good", mono=True)
    s.arrow([(985, 145), (985, 220)], ["workers serve", "the new version"], at=(995, 175), anchor="start")
    s.rect(930, 340, 290, 50, "surface", "warn", rx=25)
    s.text(1075, 370, "succeeded_reload_pending", size=13, weight=700, anchor="middle", color="warn", mono=True)
    s.arrow([(1070, 115), (1200, 115), (1200, 340)], ["not reloaded within", "poll interval + 10 min"], at=(1192, 300), anchor="end")
    s.lines(560, 505, ["Every final state releases the active-run lock and sends an email / Slack alert if turned on.",
                       "A deferred check runs as soon as the active run ends."], size=11.5, color="muted")
    return s


# =========================================================================== 6. model registry + rollback
def registry(mode):
    s = Svg(1240, 430, "Model registry in S3: immutable versions, the latest alias with previous_version, and how deploy and roll back move it", mode)
    s._markers = set()
    s.frame(20, 30, 560, 380, "s3://signatureai-df-detr-models/signatureai/detection/versions/", fill="s3", stroke="s3-line")
    vers = [("v20261109T142002Z-8a4d7444", "first model · Colab fine-tune", "line"),
            ("v20261110T032121Z-134d4c15", "retrain · gate passed", "line"),
            ("v20261110T032355Z-3f38db6c", "retrain · gate rejected", "warn")]
    for i, (v, d, tone) in enumerate(vers):
        y = 80 + i * 100
        s.rect(40, y, 520, 78, "surface", tone, rx=8)
        s.text(56, y + 24, v, size=12.5, weight=600, mono=True)
        s.text(56, y + 44, "artifact.zip · manifest.json (SHA-256, metrics, dataset)", size=11, color="muted")
        s.text(56, y + 62, d, size=11, color="warn" if tone == "warn" else "muted")
    s.box(680, 92, 300, 95, "aliases/latest.json", ['"version": "v…134d4c15"', '"previous_version": "v…8a4d7444"', '"stage": "pipeline" | "rollback"'],
          "accent-soft", "accent", mono_sub=True)
    s.arrow([(680, 160), (610, 160), (610, 219), (560, 219)], "version", at=(645, 152), color="accent")
    s.arrow([(680, 125), (590, 125), (590, 119), (560, 119)], "previous_version", at=(620, 112), color="muted", dash=True, lcolor="muted")
    s.box(680, 270, 300, 100, "Who moves the alias", ["Kaggle notebook, gate passed:", "previous_version = old, version = new", "Roll back button (EC2): version =", "previous_version, after manifest check"])
    s.arrow([(830, 270), (830, 187)], "writes", at=(838, 234), anchor="start")
    s.box(1040, 92, 180, 95, "EC2 workers", ["poll the alias every 300 s,", "download + verify SHA-256,", "load first, then swap"], "ec2", "ec2-line")
    s.arrow([(1040, 140), (980, 140)], "poll", at=(1010, 132))
    s.text(40, 400, "A rejected version stays in S3 for inspection; no alias points to it.", size=11.5, color="muted")
    return s


# =========================================================================== 7. validation gate
def gate(mode):
    s = Svg(1240, 380, "Validation gate: three checks on the held-out test set decide whether the new model is deployed", mode)
    s._markers = set()
    s.box(20, 140, 200, 90, "New model (challenger)", ["best checkpoint by", "validation mAP@50"], "accent-soft", "accent")
    checks = [("Quality floor", "test mAP@50 ≥ 0.75", "GATE_MIN_TEST_MAP50"),
              ("No regression", "test mAP@50 ≥ served − 0.02", "both scored on this run's test set"),
              ("No overfitting", "val mAP@50 − test mAP@50 ≤ 0.05", "GATE_MAX_VAL_TEST_GAP")]
    for i, (t, rule, note) in enumerate(checks):
        y = 40 + i * 110
        s.box(300, y, 300, 86, t, [rule, note])
        s.arrow([(220, 185), (260, 185), (260, y + 43), (300, y + 43)])
        s.arrow([(600, y + 43), (650, y + 43), (650, 185), (690, 185)])
    s.rect(690, 150, 140, 70, "surface", "ink", rx=8)
    s.text(760, 180, "all three pass?", size=12.5, weight=600, anchor="middle")
    s.text(760, 198, "(all reasons listed)", size=11, anchor="middle", color="muted")
    s.box(920, 40, 300, 90, "deployed", ["AUTO_DEPLOY on: alias → new version", "workers hot-reload within 300 s"], "surface", "good", title_color="good")
    s.box(920, 150, 300, 70, "approved, not deployed", ["AUTO_DEPLOY off: alias unchanged"], "surface", "warn", title_color="warn")
    s.box(920, 250, 300, 90, "rejected", ["served model keeps serving", "version + Comet run kept for review"], "surface", "bad", title_color="bad")
    s.arrow([(830, 175), (875, 175), (875, 85), (920, 85)], "yes", at=(890, 120), color="good")
    s.arrow([(830, 185), (920, 185)], None, color="warn")
    s.arrow([(830, 200), (875, 200), (875, 295), (920, 295)], "no", at=(890, 255), color="bad")
    return s


# =========================================================================== 8. notebook pipeline
def notebook(mode):
    s = Svg(1240, 360, "Training notebook on Kaggle: from the pinned dataset ZIP to an uploaded, gated model version", mode)
    s._markers = set()
    row1 = [("Download ZIP", ["pinned HF commit", "SHA-256 verified"]), ("Read annotations", ["YOLO or COCO", "to one COCO set"]),
            ("Clean", ["invalid images", "bad boxes · exact dups"]), ("Near-duplicates", ["pHash + SSIM", "confirmed pairs"]),
            ("Split + leakage gate", ["train / val / test", "no image in two splits"]), ("Warm start", ["served model from", "S3 alias latest"])]
    row2 = [("Fine-tune RT-DETRv2", ["epochs from dashboard", "early stopping on val"]), ("Test evaluation", ["held-out test set", "mAP@50, mAP@50:95"]),
            ("Calibrate threshold", ["on validation set", "precision / recall"]), ("Package", ["artifact.zip +", "manifest.json"]),
            ("Upload version", ["versions/<v>/ in S3", "checkpoints too"]), ("Validation gate", ["deploy or reject", "(see the gate figure)"])]
    w, gapx = 180, 24
    for r, row in enumerate([row1, row2]):
        y = 50 + r * 150
        for i, (t, sub) in enumerate(row):
            x = 20 + i * (w + gapx)
            fill, stroke = ("accent-soft", "accent") if t in ("Fine-tune RT-DETRv2", "Validation gate") else ("surface", "line")
            s.box(x, y, w, 80, t, sub, fill, stroke)
            if i:
                s.arrow([(x - gapx, y + 40), (x, y + 40)])
    s.arrow([(20 + 5 * (w + gapx) + w / 2, 130), (20 + 5 * (w + gapx) + w / 2, 165), (110, 165), (110, 200)], "then train", at=(600, 160))
    s.text(20, 320, "Every phase writes its status to pipeline_runs/live/<run>.json (dashboard) and its metrics and reports to Comet.", size=11.5, color="muted")
    s.text(20, 338, "Smoke mode trains on up to 2,000 / 500 train / val images; full mode on the whole dataset.", size=11.5, color="muted")
    return s


DIAGRAMS = [
    ("architecture", "System architecture", architecture),
    ("inference", "Detection request", inference),
    ("retraining", "Continuous training", retraining),
    ("cicd", "CI/CD", cicd),
    ("lifecycle", "Run lifecycle", lifecycle),
    ("registry", "Model registry and roll back", registry),
    ("gate", "Validation gate", gate),
    ("notebook", "Training notebook", notebook),
]

if __name__ == "__main__":
    out = Path(sys.argv[1])
    (out / "svg").mkdir(parents=True, exist_ok=True)
    frags = {}
    for key, title, fn in DIAGRAMS:
        frags[key] = fn("page").render()
        (out / "svg" / f"{key}.svg").write_text(fn("file").render(), encoding="utf-8")
    (out / "fragments.json").write_text(json.dumps(frags), encoding="utf-8")
    print("ok", len(frags))
