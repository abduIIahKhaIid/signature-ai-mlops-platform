"""Model wrappers: RT-DETRv2 signature detector + signature similarity embedder.

Both are licence-safe: RT-DETRv2 via Hugging Face transformers (Apache-2.0),
ResNet18 via torchvision (BSD-3). No Ultralytics code is used anywhere.
"""
from __future__ import annotations

import io
import logging
import time

import torch
from PIL import Image, ImageOps

from .config import settings
from .model_registry import ResolvedModel

log = logging.getLogger("signature.inference")


class InvalidImage(ValueError):
    pass


def load_image(data: bytes) -> Image.Image:
    Image.MAX_IMAGE_PIXELS = settings.max_image_pixels
    try:
        with Image.open(io.BytesIO(data)) as probe:
            probe.verify()  # cheap integrity check, catches truncated / non-image uploads
        image = Image.open(io.BytesIO(data))
        image = ImageOps.exif_transpose(image)  # phone photos: apply EXIF rotation
        return image.convert("RGB")
    except Exception as exc:  # PIL raises many exception types for bad input
        raise InvalidImage(f"not a valid image: {exc}") from exc


class SignatureDetector:
    def __init__(self, resolved: ResolvedModel):
        from transformers import AutoImageProcessor, AutoModelForObjectDetection

        started = time.perf_counter()
        self.version = resolved.version
        self.path = resolved.path
        self.processor = AutoImageProcessor.from_pretrained(resolved.path, use_fast=False)
        self.model = AutoModelForObjectDetection.from_pretrained(resolved.path).eval()
        self.id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        # Warm-up so the first real request does not pay one-off initialisation costs.
        self.detect(Image.new("RGB", (640, 640), "white"), threshold=1.01)
        self.load_seconds = round(time.perf_counter() - started, 3)
        log.info("detector %s loaded in %.2fs", self.version, self.load_seconds)

    @torch.inference_mode()
    def detect(self, image: Image.Image, threshold: float | None = None) -> list[dict]:
        threshold = settings.detection_threshold if threshold is None else threshold
        inputs = self.processor(images=image, return_tensors="pt")
        outputs = self.model(**inputs)
        result = self.processor.post_process_object_detection(
            outputs, threshold=threshold, target_sizes=torch.tensor([[image.height, image.width]])
        )[0]
        detections = []
        for score, label, box in zip(result["scores"], result["labels"], result["boxes"]):
            x1, y1, x2, y2 = (float(v) for v in box)
            detections.append({
                "label": self.id2label.get(int(label), str(int(label))),
                "score": round(float(score), 4),
                "box_xyxy": [round(max(0.0, x1), 1), round(max(0.0, y1), 1),
                             round(min(float(image.width), x2), 1), round(min(float(image.height), y2), 1)],
            })
        detections.sort(key=lambda d: d["score"], reverse=True)
        return detections


def crop_with_margin(image: Image.Image, box_xyxy: list[float], margin: float = 0.05) -> Image.Image:
    x1, y1, x2, y2 = box_xyxy
    mx, my = (x2 - x1) * margin, (y2 - y1) * margin
    left, top = max(0, int(x1 - mx)), max(0, int(y1 - my))
    right, bottom = min(image.width, int(x2 + mx) + 1), min(image.height, int(y2 + my) + 1)
    if right - left < 2 or bottom - top < 2:
        return image
    return image.crop((left, top, right, bottom))


class SignatureEmbedder:
    """Baseline similarity: ImageNet ResNet18 embeddings + cosine similarity.

    SIMILARITY_WEIGHTS_PATH can point to a fine-tuned Siamese ResNet18 state_dict later;
    the API contract stays the same. Scores from the pretrained baseline are NOT calibrated
    for forgery detection, so the match threshold must be tuned on a labelled pair set.
    """

    MEAN = (0.485, 0.456, 0.406)
    STD = (0.229, 0.224, 0.225)

    def __init__(self, pretrained: bool = True, weights_path: str | None = None):
        import torchvision

        started = time.perf_counter()
        weights = torchvision.models.ResNet18_Weights.DEFAULT if pretrained and not weights_path else None
        model = torchvision.models.resnet18(weights=weights)
        model.fc = torch.nn.Identity()
        if weights_path:
            state = torch.load(weights_path, map_location="cpu", weights_only=True)
            missing, unexpected = model.load_state_dict(state, strict=False)
            if missing or unexpected:
                raise RuntimeError(f"similarity weights do not match ResNet18: missing={missing[:3]} unexpected={unexpected[:3]}")
        self.model = model.eval()
        self.name = "resnet18-finetuned" if weights_path else ("resnet18-imagenet" if pretrained else "resnet18-random")
        self.version: str | None = None
        self.threshold: float | None = None  # validated threshold shipped with fine-tuned weights
        self.load_seconds = round(time.perf_counter() - started, 3)

    def _preprocess(self, image: Image.Image) -> torch.Tensor:
        gray = ImageOps.autocontrast(image.convert("L"))
        side = max(gray.size)
        canvas = Image.new("L", (side, side), 255)  # pad to square on white paper, keep aspect ratio
        canvas.paste(gray, ((side - gray.width) // 2, (side - gray.height) // 2))
        canvas = canvas.resize((224, 224), Image.BILINEAR).convert("RGB")
        tensor = torch.frombuffer(bytearray(canvas.tobytes()), dtype=torch.uint8).view(224, 224, 3)
        tensor = tensor.permute(2, 0, 1).float().div(255)
        mean = torch.tensor(self.MEAN).view(3, 1, 1)
        std = torch.tensor(self.STD).view(3, 1, 1)
        return ((tensor - mean) / std).unsqueeze(0)

    @torch.inference_mode()
    def embed(self, image: Image.Image) -> torch.Tensor:
        vector = self.model(self._preprocess(image))[0]
        return torch.nn.functional.normalize(vector, dim=0)

    def similarity(self, a: Image.Image, b: Image.Image) -> float:
        return float(torch.dot(self.embed(a), self.embed(b)))

    @torch.inference_mode()
    def embed_many(self, images: list[Image.Image]) -> torch.Tensor:
        """L2-normalised embeddings of several crops in one forward pass (rows follow the input order)."""
        if not images:
            return torch.empty(0, 512)
        batch = torch.cat([self._preprocess(image) for image in images])
        return torch.nn.functional.normalize(self.model(batch), dim=1)
