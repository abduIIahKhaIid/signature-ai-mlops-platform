"""Hand-laid-out AWS architecture diagram (official AWS icons from the "diagrams" package), as SVG + PNG.

    pip install diagrams                              # only for its icon files
    python docs/architecture/src/make_icons.py        # once: generic icons for non-AWS services
    python docs/architecture/src/aws_architecture_svg.py
    # → docs/architecture/aws/aws_architecture.svg and .png (PNG needs rsvg-convert: apt install librsvg2-bin)

Coordinates are fixed so the picture stays tidy; change positions in NODES and routes in EDGES.
"""
from __future__ import annotations

import base64
import shutil
import subprocess
from html import escape
from pathlib import Path

import diagrams

SRC = Path(__file__).resolve().parent
OUT = SRC.parent / "aws"
RES = Path(diagrams.__file__).resolve().parent.parent / "resources"
ICONS = SRC / "icons"

W, H = 1820, 1150
FONT = "DejaVu Sans, Helvetica, Arial, sans-serif"
SERVE, TRAIN, DEPLOY, IAMC = "#232F3E", "#1B7F5F", "#3B48CC", "#BF0816"

ICON = {
    "users": RES / "aws/general/users.png",
    "eip": RES / "aws/compute/ec2-elastic-ip-address.png",
    "s3": RES / "aws/storage/simple-storage-service-s3-bucket.png",
    "ecr": RES / "aws/compute/ec2-container-registry.png",
    "secrets": RES / "aws/security/secrets-manager.png",
    "ssm": RES / "aws/management/systems-manager-run-command.png",
    "role": RES / "aws/security/identity-and-access-management-iam-role.png",
    "caddy": RES / "onprem/network/caddy.png",
    "fastapi": RES / "programming/framework/fastapi.png",
    "redis": RES / "onprem/inmemory/redis.png",
    "celery": RES / "onprem/queue/celery.png",
    "github": RES / "onprem/vcs/github.png",
    "actions": RES / "onprem/ci/github-actions.png",
    "discord": RES / "saas/chat/discord.png",
    "dataset": ICONS / "dataset.png",
    "gpu": ICONS / "gpu.png",
    "tracking": ICONS / "tracking.png",
    "traces": ICONS / "traces.png",
    "laptop": ICONS / "laptop.png",
}

# (x, y) = icon centre. Label lines are drawn under the icon.
NODES = {
    "users":    (130, 430, "users", ["Users", "web app · curl · Locust"]),
    "annot":    (90, 225, "laptop", ["Local PC", "dataset dashboard"]),
    "hf":       (215, 225, "dataset", ["Hugging Face", "dataset ZIP repo"]),
    "repo":     (90, 905, "github", ["GitHub repo"]),
    "actions":  (215, 905, "actions", ["GitHub Actions", "CI/CD"]),
    "eip":      (405, 430, "eip", ["Elastic IP"]),
    "caddy":    (555, 430, "caddy", ["caddy", "HTTPS :443 (opt.)"]),
    "api":      (705, 430, "fastapi", ["api  FastAPI :8000", "React web app", "/v1/detect · /v1/verify", "/pipeline · /webhooks"]),
    "redis":    (870, 430, "redis", ["redis", "queues · state"]),
    "worker":   (1000, 320, "celery", ["worker", "RT-DETRv2 detector", "Siamese ResNet18"]),
    "pipeline": (1000, 560, "celery", ["pipeline", "retraining", "orchestrator"]),
    "s3":       (1265, 430, "s3", ["Amazon S3", "model registry", "versions · aliases", "pipeline_runs"]),
    "ssm":      (430, 900, "ssm", ["Systems Manager", "Run Command"]),
    "ecr":      (620, 900, "ecr", ["Amazon ECR", "signatureai images"]),
    "secrets":  (820, 900, "secrets", ["Secrets Manager", "signatureai/prod/dotenv"]),
    "role":     (1000, 900, "role", ["IAM role", "SignatureAI-EC2-Role"]),
    "kaggle":   (1540, 215, "gpu", ["Kaggle T4 GPU", "retraining notebook", "clean · fine-tune · gate"]),
    "comet":    (1700, 215, "tracking", ["Comet", "experiments"]),
    "logfire":  (1540, 760, "traces", ["Logfire", "traces · logs · metrics"]),
    "alerts":   (1700, 760, "discord", ["Discord / Slack", "e-mail alerts"]),
}
ISZ = 64  # icon size

# (title, x, y, w, h, fill, stroke, dash, title colour)
GROUPS = [
    ("AWS Cloud · ap-southeast-2 (Sydney)", 285, 130, 1095, 900, "#F2F8FD", "#232F3E", "", "#232F3E"),
    ("VPC (default) · public subnet", 325, 165, 790, 560, "#F3FAEF", "#7AA116", "6,4", "#4F7A0A"),
    ("Security group signatureai-api-sg: TCP 8000 (+ 443 optional)", 345, 195, 755, 515, "none", "#DD344C", "3,3", "#B0263B"),
    ("_EC2 t3.large · Ubuntu 24.04 · docker compose (4 containers)", 480, 270, 600, 420, "#FFF6EC", "#ED7100", "", "#B35400"),
    ("Dataset side", 25, 150, 255, 160, "#F7F7F9", "#9AA0AA", "", "#555"),
    ("Code", 25, 830, 255, 175, "#F7F7F9", "#9AA0AA", "", "#555"),
    ("_Outside AWS: training & monitoring", 1440, 140, 355, 760, "#F7F7F9", "#9AA0AA", "", "#555"),
]

# (points, colour, dash, label, label (x, y), marker at end)
EDGES = [
    # serving: request → queue → worker → model
    ([(170, 430), (370, 430)], SERVE, "", "HTTP / HTTPS", (270, 420)),
    ([(440, 430), (520, 430)], SERVE, "", "", None),
    ([(590, 430), (670, 430)], SERVE, "", "", None),
    ([(740, 430), (835, 430)], SERVE, "", "enqueue", (788, 420)),
    ([(870, 395), (870, 320), (965, 320)], SERVE, "", "deliver job", (915, 310)),
    ([(1035, 320), (1140, 320), (1140, 415), (1230, 415)], SERVE, "", "model by alias (hot reload)", (1135, 305)),
    # continuous training
    ([(140, 225), (178, 225)], TRAIN, "", "", None),
    ([(250, 225), (300, 225), (300, 245), (705, 245), (705, 395)], TRAIN, "", "webhook (new commit)", (520, 245)),
    ([(902, 450), (935, 450), (935, 560), (965, 560)], TRAIN, "", "queue 'pipeline'", (935, 508)),
    ([(1035, 545), (1190, 545), (1190, 445), (1230, 445)], TRAIN, "", "control + progress", (1112, 545)),
    ([(1035, 565), (1410, 565), (1410, 230), (1505, 230)], TRAIN, "", "push notebook + secrets", (1300, 565)),
    ([(1505, 195), (1265, 195), (1265, 395)], TRAIN, "", "new version + alias (gate passed)", (1385, 185)),
    ([(215, 190), (215, 95), (1540, 95), (1540, 180)], TRAIN, "7,5", "download pinned ZIP, verify SHA-256", (880, 85)),
    ([(1575, 215), (1665, 215)], TRAIN, "", "metrics", (1620, 205)),
    ([(1035, 585), (1700, 585), (1700, 725)], TRAIN, "", "alerts", (1560, 585)),
    # code deploy
    ([(130, 905), (180, 905)], DEPLOY, "7,5", "", None),
    ([(250, 905), (395, 905)], DEPLOY, "7,5", "SendCommand", (322, 895)),
    ([(215, 980), (215, 1015), (555, 1015), (555, 900), (585, 900)], DEPLOY, "7,5", "push images", (390, 1015)),
    ([(430, 865), (430, 600), (480, 600)], DEPLOY, "7,5", "remote_deploy.sh", (430, 760)),
    ([(620, 865), (620, 690)], DEPLOY, "7,5", "pull images", (620, 780)),
    ([(820, 865), (820, 690)], DEPLOY, "7,5", ".env", (820, 780)),
    # permissions + observability
    ([(1000, 865), (1000, 690)], IAMC, "2,4", "instance profile", (1000, 780)),
    ([(1050, 690), (1050, 760), (1505, 760)], SERVE, "2,4", "traces (api + worker)", (1280, 750)),
]


def b64(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def text(x, y, s, size=13, weight="normal", color="#232F3E", anchor="middle", bg=False):
    out = ""
    if bg:
        w = len(s) * size * 0.58 + 10
        out += f'<rect x="{x - w / 2:.0f}" y="{y - size + 1}" width="{w:.0f}" height="{size + 6}" rx="3" fill="white" opacity="0.92"/>'
    out += (f'<text x="{x}" y="{y + 3}" font-family="{FONT}" font-size="{size}" font-weight="{weight}" '
            f'fill="{color}" text-anchor="{anchor}">{escape(s)}</text>')
    return out


def build() -> str:
    p = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         '<defs>']
    for name, col in (("serve", SERVE), ("train", TRAIN), ("deploy", DEPLOY), ("iam", IAMC)):
        p.append(f'<marker id="a-{name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
                 f'orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{col}"/></marker>')
    p.append('</defs><rect width="100%" height="100%" fill="white"/>')
    p.append(text(W / 2, 38, "SignatureAI — architecture on AWS", 26, "bold"))
    p.append(text(W / 2, 64, "signature detection (RT-DETRv2) · similarity (Siamese ResNet18) · "
                  "FastAPI + Redis + Celery on EC2 · continuous training on Kaggle", 14, color="#5A6270"))

    for title, x, y, w, h, fill, stroke, dash, tcol in GROUPS:
        da = f' stroke-dasharray="{dash}"' if dash else ""
        p.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10" fill="{fill}" stroke="{stroke}" '
                 f'stroke-width="2"{da}/>')
        if title.startswith("_"):  # title at the bottom of the box
            p.append(text(x + 12, y + h - 12, title[1:], 14, "bold", tcol, "start"))
        else:
            p.append(text(x + 12, y + 20, title, 14, "bold", tcol, "start"))

    mk = {SERVE: "serve", TRAIN: "train", DEPLOY: "deploy", IAMC: "iam"}
    for pts, col, dash, label, lpos in EDGES:
        d = "M" + " L".join(f"{x},{y}" for x, y in pts)
        da = f' stroke-dasharray="{dash}"' if dash else ""
        p.append(f'<path d="{d}" fill="none" stroke="{col}" stroke-width="2.2"{da} '
                 f'marker-end="url(#a-{mk[col]})" stroke-linejoin="round"/>')
    for pts, col, dash, label, lpos in EDGES:  # labels on top of every line
        if label and lpos:
            p.append(text(lpos[0], lpos[1], label, 12, "bold", col, bg=True))

    for key, (x, y, ic, lines) in NODES.items():
        p.append(f'<image href="{b64(ICON[ic])}" x="{x - ISZ / 2}" y="{y - ISZ / 2}" width="{ISZ}" height="{ISZ}"/>')
        for i, line in enumerate(lines):
            p.append(text(x, y + ISZ / 2 + 16 + i * 15, line, 12.5 if i == 0 else 11.5,
                          "bold" if i == 0 else "normal", "#232F3E" if i == 0 else "#4A5260"))

    # legend
    ly = H - 70
    items = [(SERVE, "", "request · model loading"), (TRAIN, "", "continuous training (dataset → model)"),
             (DEPLOY, "7,5", "code deploy (git push → EC2)"), (IAMC, "2,4", "IAM permission"),
             (SERVE, "2,4", "observability")]
    x = 300
    for col, dash, label in items:
        da = f' stroke-dasharray="{dash}"' if dash else ""
        p.append(f'<path d="M{x},{ly} L{x + 48},{ly}" stroke="{col}" stroke-width="2.4"{da} '
                 f'marker-end="url(#a-{mk[col]})"/>')
        p.append(text(x + 58, ly, label, 13, color="#232F3E", anchor="start"))
        x += 70 + len(label) * 7.6
    p.append(text(W / 2, H - 30, "No dataset is stored in AWS: ZIPs go Hugging Face → Kaggle. S3 holds models, "
                  "aliases and small run records only. No AWS keys on EC2 (instance role).", 12.5, color="#5A6270"))
    p.append("</svg>")
    return "\n".join(p)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    svg = OUT / "aws_architecture.svg"
    svg.write_text(build(), encoding="utf-8")
    print("wrote", svg)
    if shutil.which("rsvg-convert"):
        png = OUT / "aws_architecture.png"
        subprocess.run(["rsvg-convert", "-z", "2", "-o", str(png), str(svg)], check=True)
        print("wrote", png)
    else:
        print("rsvg-convert not found: open the SVG in a browser, or install librsvg2-bin for the PNG")
