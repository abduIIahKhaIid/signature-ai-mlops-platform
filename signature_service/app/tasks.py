"""Celery worker tasks. Models are loaded once per worker process, not per request."""
from __future__ import annotations

import logging
import os
import threading
import time

from celery.signals import worker_process_init, worker_process_shutdown

from . import observability
from .celery_app import DETECT_TASK, MODEL_INFO_TASK, VERIFY_TASK, celery_app
from .config import settings
from .storage import get_storage

log = logging.getLogger("signature.worker")


class ReleaseBackoff(RuntimeError):
    """This release failed recently; it is not downloaded again before its retry time (FAILED_RELEASE_RETRY_SECONDS)."""


class ModelHolder:
    """Holds current models and atomically hot-swaps either model when its approved S3 alias moves."""

    def __init__(self):
        self.detector = None
        self.embedder = None
        self.process_started = time.time()
        self.cold_start_seconds = None
        self._swap_lock = threading.Lock()
        self._stop = threading.Event()
        self.last_reload_error = None
        self.last_detector_reload_error = None
        self.last_similarity_reload_error = None
        self._failed_releases: dict[str, tuple[float, str]] = {}  # release key -> (retry after epoch, error)
        self._logged_errors: dict[str, str] = {}                   # kind -> last error written with a traceback

    # ---------------------------------------------------------------- failed-release backoff
    def _check_backoff(self, key: str) -> None:
        failed = self._failed_releases.get(key)
        if failed and time.time() < failed[0]:
            retry_at = time.strftime("%H:%M:%S UTC", time.gmtime(failed[0]))
            raise ReleaseBackoff(f"{failed[1]} [release {key} failed; not downloaded again before {retry_at} "
                                 "unless the alias moves to another release]")

    def _remember_failure(self, key: str, exc: Exception) -> None:
        self._failed_releases[key] = (time.time() + settings.failed_release_retry_seconds, repr(exc))

    @staticmethod
    def _similarity_key(alias: dict) -> str:
        return f"similarity:{alias['version']}:{str(alias.get('sha256', ''))[:12]}"

    @staticmethod
    def _load_similarity_from_s3(alias=None):
        """Build and smoke-test a complete embedder before it becomes visible to any request."""
        import torch
        from PIL import Image

        from .inference import SignatureEmbedder
        from .model_registry import fetch_similarity_weights

        weights, meta = fetch_similarity_weights(alias=alias)
        embedder = SignatureEmbedder(False, str(weights))
        embedder.version = meta["version"]
        embedder.threshold = float(meta["recommended_threshold"])
        vector = embedder.embed(Image.new("L", (256, 96), 255))
        if vector.shape != (512,) or not torch.isfinite(vector).all():
            raise RuntimeError("similarity model smoke test returned an invalid embedding")
        return embedder

    def load(self) -> None:
        import torch

        from .inference import SignatureDetector, SignatureEmbedder
        from .model_registry import resolve_current_model

        torch.set_num_threads(settings.torch_threads)
        started = time.perf_counter()
        with observability.span("load_models"):
            self.detector = SignatureDetector(resolve_current_model())
            self.embedder = self._load_similarity_safely(SignatureEmbedder)
        self.cold_start_seconds = round(time.perf_counter() - started, 3)
        log.info("models ready in %.2fs (detector=%s similarity=%s)", self.cold_start_seconds,
                 self.detector.version, self.embedder.version if self.embedder else None)

    def _load_similarity_safely(self, embedder_cls):
        """The similarity model is optional for detection, so it must never stop a worker from starting.

        If it cannot be loaded (bad S3 alias, checksum mismatch, wrong weights, ...) the worker starts with the
        detector only: /v1/detect keeps working, /v1/verify and the pair comparison answer with the reason, and the
        hot-reload loop keeps re-checking the similarity alias, so a corrected alias is picked up without a restart.
        """
        if not settings.enable_similarity:
            return None
        key = None
        try:
            with observability.span("load_similarity"):
                if settings.similarity_s3_alias:
                    from .model_registry import current_similarity_target

                    alias = current_similarity_target()
                    key = self._similarity_key(alias) if alias else None
                    embedder = self._load_similarity_from_s3(alias)
                else:
                    embedder = embedder_cls(settings.similarity_pretrained, settings.similarity_weights_path)
        except Exception as exc:
            if key:
                self._remember_failure(key, exc)  # the poll loop will not re-download this release at once
            self.last_similarity_reload_error = f"start-up: {exc!r}"
            self.last_reload_error = f"similarity: {exc!r}"
            log.exception("similarity model could not be loaded at start-up; detection keeps working without it")
            return None
        self.last_similarity_reload_error = None
        return embedder

    def ensure_loaded(self) -> None:
        if self.detector is None:  # e.g. eager mode in tests, where worker signals do not fire
            with self._swap_lock:
                if self.detector is None:
                    self.load()

    def start_hot_reload(self) -> None:
        detection_follows_alias = (settings.model_source == "s3" and not settings.model_version
                                   and bool(settings.model_s3_bucket))
        similarity_follows_alias = (settings.enable_similarity and bool(settings.similarity_s3_alias)
                                    and bool(settings.model_s3_bucket))
        if settings.model_poll_seconds <= 0 or not (detection_follows_alias or similarity_follows_alias):
            return
        threading.Thread(target=self._poll_loop, name="model-hot-reload", daemon=True).start()

    def _poll_loop(self) -> None:
        while not self._stop.wait(settings.model_poll_seconds):
            self.poll_once()

    def poll_once(self) -> None:
        """One hot-reload check of both aliases. A failure never replaces the model that is being served."""
        errors = []
        for kind, reload in (("detector", self._reload_detector_if_needed),
                             ("similarity", self._reload_similarity_if_needed)):
            try:
                reload()
                error = None
            except ReleaseBackoff as exc:   # known broken release: keep reporting it, but no download, no traceback
                error = str(exc)
            except Exception as exc:
                error = repr(exc)
                if self._logged_errors.get(kind) != error:   # full traceback once per distinct error
                    log.exception("%s hot reload failed; still serving the current %s model", kind, kind)
                else:
                    log.warning("%s hot reload still failing: %s", kind, error)
            if error is None:
                self._logged_errors.pop(kind, None)
            else:
                self._logged_errors.setdefault(kind, error)
                errors.append(f"{kind}: {error}")
            setattr(self, f"last_{kind}_reload_error", error)
        self.last_reload_error = "; ".join(errors) or None

    def _reload_detector_if_needed(self) -> None:
        if settings.model_source != "s3" or settings.model_version or not settings.model_s3_bucket:
            return
        from .inference import SignatureDetector
        from .model_registry import S3ModelRegistry, current_target_version

        target = current_target_version()
        if target and self.detector is not None and target != self.detector.version:
            key = f"detector:{target}"
            self._check_backoff(key)
            log.info("detector alias moved %s -> %s; loading new model", self.detector.version, target)
            registry = S3ModelRegistry(settings.model_s3_bucket, settings.model_s3_prefix,
                                       settings.model_cache_dir)
            try:
                new_detector = SignatureDetector(registry.fetch(target))  # load BEFORE swapping
            except Exception as exc:
                self._remember_failure(key, exc)
                raise
            with self._swap_lock:
                self.detector = new_detector
            log.info("detector hot reload complete: now serving %s", target)

    def _reload_similarity_if_needed(self) -> None:
        if not settings.enable_similarity or not settings.similarity_s3_alias or not settings.model_s3_bucket:
            return
        from .model_registry import current_similarity_target

        alias = current_similarity_target()
        current = self.embedder.version if self.embedder else None
        if alias and alias["version"] != current:
            key = self._similarity_key(alias)
            self._check_backoff(key)
            log.info("similarity alias moved %s -> %s; loading new model", current, alias["version"])
            try:
                new_embedder = self._load_similarity_from_s3(alias)  # checksum + load + smoke test before swap
            except Exception as exc:
                self._remember_failure(key, exc)
                raise
            with self._swap_lock:
                self.embedder = new_embedder
            log.info("similarity hot reload complete: now serving %s (threshold=%.6f)",
                     new_embedder.version, new_embedder.threshold)

    def stop(self) -> None:
        self._stop.set()


models = ModelHolder()


@worker_process_init.connect
def _init_worker_process(**_):
    if settings.worker_role != "inference":  # the pipeline (retraining) worker has no torch and serves no model
        observability.setup(settings.worker_role)
        return
    observability.setup("worker")
    models.load()
    models.start_hot_reload()


@worker_process_shutdown.connect
def _shutdown_worker_process(**_):
    models.stop()


def _read_image(key: str):
    from .inference import load_image

    return load_image(get_storage().get(key))


class TransientError(RuntimeError):
    """A temporary problem (network, storage, simulated) that is worth retrying."""


def _retryable_errors() -> tuple:
    errors = [TransientError, ConnectionError, TimeoutError]
    try:
        from botocore.exceptions import ConnectTimeoutError, EndpointConnectionError, ReadTimeoutError

        errors += [EndpointConnectionError, ConnectTimeoutError, ReadTimeoutError]
    except ImportError:
        pass
    return tuple(errors)


RETRYABLE = _retryable_errors()
# Bad input (InvalidImage) and bugs are NOT retried: they would fail the same way again.
RETRY_OPTIONS = dict(bind=True, autoretry_for=RETRYABLE, max_retries=settings.max_retries,
                     retry_backoff=2, retry_backoff_max=30, retry_jitter=True)


def _start(task, enqueued_at: float | None, simulate_failures: int) -> float | None:
    """Queue delay for monitoring + optional simulated transient failures for the retry demo."""
    queue_wait_ms = round((time.time() - enqueued_at) * 1000, 1) if enqueued_at else None
    if simulate_failures and settings.allow_failure_simulation and task.request.retries < simulate_failures:
        raise TransientError(f"simulated transient failure (attempt {task.request.retries + 1})")
    return queue_wait_ms


def _cleanup(task, keys: list[str], exc: Exception | None = None) -> None:
    """Delete uploads once the job is final; keep them while a retry is still coming."""
    retry_pending = isinstance(exc, RETRYABLE) and task.request.retries < task.max_retries
    if retry_pending:
        log.warning("job %s attempt %d failed (%s); will retry", task.request.id, task.request.retries + 1, exc)
        return
    for key in keys:
        get_storage().delete(key)


def similarity_unavailable_reason() -> str:
    """Why this worker has no similarity model: switched off, or it failed to load (with the error)."""
    if not settings.enable_similarity:
        return "similarity is disabled on this worker (ENABLE_SIMILARITY=false)"
    retry = (f"; the worker re-checks the S3 alias every {settings.model_poll_seconds} s"
             if settings.similarity_s3_alias and settings.model_poll_seconds > 0 else "")
    return (f"the similarity model is not loaded on this worker ({models.last_similarity_reload_error or 'unknown error'})"
            f"{retry}. Detection is not affected.")


def pairwise_similarity(image, detections: list[dict], embedder) -> dict:
    """Compare every pair of detected signatures on one page with the similarity model (Siamese ResNet18).

    The top COMPARE_MAX_SIGNATURES boxes (detections are sorted by score) are cropped with the same 5 % margin the
    verify endpoint uses, embedded in one batch, and compared by cosine similarity. Pair indexes a/b point into
    `detections`, so the browser can hide pairs whose boxes fall under its confidence slider.
    """
    if embedder is None:
        return {"available": False, "reason": similarity_unavailable_reason()}
    from .inference import crop_with_margin

    top = detections[: max(2, settings.compare_max_signatures)]
    t0 = time.perf_counter()
    with observability.span("pairwise_similarity", signatures=len(top)):
        vectors = embedder.embed_many([crop_with_margin(image, d["box_xyxy"]) for d in top])
        scores = (vectors @ vectors.T).tolist()
    threshold = embedder.threshold if embedder.threshold is not None else settings.similarity_match_threshold
    pairs = [{"a": a, "b": b, "similarity": round(scores[a][b], 4), "score_percent": round(max(0.0, scores[a][b]) * 100, 1),
              "match": scores[a][b] >= threshold}
             for a in range(len(top)) for b in range(a + 1, len(top))]
    pairs.sort(key=lambda p: p["similarity"], reverse=True)
    return {
        "available": True, "model": embedder.name, "version": embedder.version, "threshold": threshold,
        "compared": len(top), "detected": len(detections), "pairs": pairs,
        "ms": round((time.perf_counter() - t0) * 1000, 1),
        "note": ("Siamese ResNet18; threshold loaded from the validated S3 model alias." if embedder.version
                 else "Baseline score; threshold is not calibrated for forgery detection."),
    }


@celery_app.task(name=DETECT_TASK, **RETRY_OPTIONS)
def detect_signature(self, image_key: str, threshold: float | None = None,
                     enqueued_at: float | None = None, simulate_failures: int = 0, compare: bool = True) -> dict:
    started = time.perf_counter()
    similarity = None
    try:
        queue_wait_ms = _start(self, enqueued_at, simulate_failures)
        models.ensure_loaded()
        detector = models.detector  # local reference: a hot swap mid-request cannot mix models
        with observability.span("detect", model_version=detector.version, retries=self.request.retries,
                                queue_wait_ms=queue_wait_ms if queue_wait_ms is not None else -1):
            image = _read_image(image_key)
            t0 = time.perf_counter()
            with observability.span("model_inference", model_version=detector.version,
                                    image_width=image.width, image_height=image.height):
                detections = detector.detect(image, threshold)
            inference_ms = (time.perf_counter() - t0) * 1000
            observability.log_info("detect done", inference_ms=round(inference_ms, 1), detections=len(detections),
                                   queue_wait_ms=queue_wait_ms if queue_wait_ms is not None else -1)
            if compare and len(detections) >= 2:
                similarity = pairwise_similarity(image, detections, models.embedder)
    except Exception as exc:
        _cleanup(self, [image_key], exc)
        raise
    _cleanup(self, [image_key])
    total_ms = (time.perf_counter() - started) * 1000
    log.info("detect ok job=%s model=%s detections=%d queue_wait_ms=%s inference_ms=%.1f retries=%d",
             self.request.id, detector.version, len(detections), queue_wait_ms, inference_ms, self.request.retries)
    return {
        "model_version": detector.version,
        "image_size": {"width": image.width, "height": image.height},
        "signature_count": len(detections),
        "detections": detections,
        "similarity": similarity,   # None unless compare and 2+ signatures; see pairwise_similarity
        "timings_ms": {"queue_wait": queue_wait_ms, "inference": round(inference_ms, 1),
                       "similarity": similarity.get("ms") if similarity else None, "total_worker": round(total_ms, 1)},
        "retries": self.request.retries,
        "worker_pid": os.getpid(),
    }


@celery_app.task(name=VERIFY_TASK, **RETRY_OPTIONS)
def verify_signatures(self, reference_key: str, candidate_key: str, crop: bool = True,
                      enqueued_at: float | None = None, simulate_failures: int = 0) -> dict:
    from .inference import crop_with_margin

    keys = [reference_key, candidate_key]
    started = time.perf_counter()
    try:
        queue_wait_ms = _start(self, enqueued_at, simulate_failures)
        models.ensure_loaded()
        if models.embedder is None:
            raise RuntimeError(similarity_unavailable_reason())
        detector, embedder = models.detector, models.embedder
        with observability.span("verify", model_version=detector.version, retries=self.request.retries,
                                queue_wait_ms=queue_wait_ms if queue_wait_ms is not None else -1):
            sides = {}
            crops = []
            for name, key in (("reference", reference_key), ("candidate", candidate_key)):
                image = _read_image(key)
                best = None
                if crop:
                    found = detector.detect(image)
                    best = found[0] if found else None
                crops.append(crop_with_margin(image, best["box_xyxy"]) if best else image)
                sides[name] = {"detection": best, "used_full_image": best is None,
                               "image_size": {"width": image.width, "height": image.height}}
            similarity = embedder.similarity(crops[0], crops[1])
    except Exception as exc:
        _cleanup(self, keys, exc)
        raise
    _cleanup(self, keys)
    log.info("verify ok job=%s similarity=%.4f queue_wait_ms=%s retries=%d",
             self.request.id, similarity, queue_wait_ms, self.request.retries)
    threshold = embedder.threshold if embedder.threshold is not None else settings.similarity_match_threshold
    return {
        "similarity": round(similarity, 4),
        "score_percent": round(max(0.0, similarity) * 100, 1),
        "match": similarity >= threshold,
        "threshold": threshold,
        "similarity_model": embedder.name,
        "similarity_version": embedder.version,
        "detector_version": detector.version,
        "reference": sides["reference"],
        "candidate": sides["candidate"],
        "note": ("Siamese ResNet18; threshold loaded from the validated S3 model alias." if embedder.version
                 else "Baseline score; threshold is not calibrated for forgery detection."),
        "timings_ms": {"queue_wait": queue_wait_ms,
                       "total_worker": round((time.perf_counter() - started) * 1000, 1)},
        "retries": self.request.retries,
    }


@celery_app.task(name=MODEL_INFO_TASK)
def model_info() -> dict:
    models.ensure_loaded()
    return {
        "detector_version": models.detector.version,
        "detector_load_seconds": models.detector.load_seconds,
        "similarity_model": models.embedder.name if models.embedder else None,
        "similarity_version": models.embedder.version if models.embedder else None,
        "similarity_threshold": (models.embedder.threshold if models.embedder and models.embedder.threshold is not None
                                 else settings.similarity_match_threshold),
        "cold_start_seconds": models.cold_start_seconds,
        "worker_uptime_seconds": round(time.time() - models.process_started, 1),
        "hot_reload_poll_seconds": settings.model_poll_seconds,
        "last_reload_error": models.last_reload_error,
        "last_detector_reload_error": models.last_detector_reload_error,
        "last_similarity_reload_error": models.last_similarity_reload_error,
        "worker_pid": os.getpid(),
    }
