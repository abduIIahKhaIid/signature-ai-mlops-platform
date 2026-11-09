"""Test helpers: a tiny random RT-DETRv2 'best_model' and a registry laid out exactly like
the training notebook writes it (versions/<v>/artifact.zip + manifest.json + aliases/*.json)."""
from __future__ import annotations

import hashlib
import io
import json
import random
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw


def build_tiny_model(dest: Path, version: str, seed: int = 0) -> Path:
    import torch
    from transformers import (RTDetrImageProcessor, RTDetrResNetConfig, RTDetrV2Config,
                              RTDetrV2ForObjectDetection)

    torch.manual_seed(seed)
    backbone = RTDetrResNetConfig(layer_type="basic", depths=[1, 1, 1, 1], hidden_sizes=[32, 64, 128, 256],
                                  embedding_size=32, out_features=["stage2", "stage3", "stage4"])
    config = RTDetrV2Config(backbone_config=backbone, encoder_in_channels=[64, 128, 256], decoder_layers=1,
                            num_labels=1, id2label={0: "signature"}, label2id={"signature": 0})
    model_dir = dest / "best_model"
    RTDetrV2ForObjectDetection(config).save_pretrained(model_dir, safe_serialization=True)
    RTDetrImageProcessor().save_pretrained(model_dir)
    (model_dir / "version_metadata.json").write_text(json.dumps({"version": version}))
    return model_dir


def publish_version(s3, bucket: str, prefix: str, version: str, work: Path, *, alias: str | None = "latest",
                    tamper: bool = False, seed: int = 0) -> None:
    root = work / version
    model_dir = build_tiny_model(root, version, seed)
    archive = root / "artifact.zip"
    with zipfile.ZipFile(archive, "w") as z:
        for p in sorted(model_dir.rglob("*")):
            z.write(p, arcname=str(p.relative_to(root)))
    sha = hashlib.sha256(archive.read_bytes()).hexdigest()
    manifest = {"version": version, "artifact_sha256": "0" * 64 if tamper else sha,
                "model_subdirectory": "best_model", "status": "candidate"}
    base = f"{prefix}/versions/{version}"
    s3.upload_file(str(archive), bucket, f"{base}/artifact.zip")
    s3.put_object(Bucket=bucket, Key=f"{base}/manifest.json", Body=json.dumps(manifest))
    if alias:
        s3.put_object(Bucket=bucket, Key=f"{prefix}/aliases/{alias}.json",
                      Body=json.dumps({"version": version, "artifact_key": f"{base}/artifact.zip", "sha256": sha}))


def document_png(seed: int = 0, size=(900, 600)) -> bytes:
    """Synthetic 'document' with printed lines and a scribbled signature."""
    rng = random.Random(seed)
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    for y in range(60, 300, 30):
        draw.line([(60, y), (size[0] - 60, y)], fill=(170, 170, 170), width=2)
    points = [(500 + i * 12, 450 + rng.randint(-30, 30)) for i in range(25)]
    draw.line(points, fill=(10, 10, 80), width=4)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
