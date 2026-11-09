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


class ModelHolder:
    """Holds the current models and hot-swaps the detector when the S3 alias moves."""

    def __init__(self):
        self.detector = None
        self.embedder = None
        self.process_started = time.time()
        self.cold_start_seconds = None
        self._swap_lock = threading.Lock()
        self._stop = threading.Event()
        self.last_reload_error = None

    def load(self) -> None:
        import torch

        from .inference import SignatureDetector, SignatureEmbedder
        from .model_registry import resolve_current_model

        torch.set_num_threads(settings.torch_threads)
        started = time.perf_counter()
        with observability.span("load_models"):
            self.detector = SignatureDetector(resolve_current_model())
            if settings.enable_similarity:
                if settings.similarity_s3_alias:
                    from .model_registry import fetch_similarity_weights

                    weights, meta = fetch_similarity_weights()
                    self.embedder = SignatureEmbedder(False, str(weights))
                    self.embedder.version = meta["version"]
                    self.embedder.threshold = meta.get("recommended_threshold")
                else:
                    self.embedder = SignatureEmbedder(settings.similarity_pretrained, settings.similarity_weights_path)
        self.cold_start_seconds = round(time.perf_counter() - started, 3)
        log.info("models ready in %.2fs (detector=%s)", self.cold_start_seconds, self.detector.version)

    def ensure_loaded(self) -> None:
        if self.detector is None:  # e.g. eager mode in tests, where worker signals do not fire
            with self._swap_lock:
                if self.detector is None:
                    self.load()

    def start_hot_reload(self) -> None:
        if settings.model_poll_seconds <= 0 or settings.model_source != "s3" or settings.model_version:
            return
        threading.Thread(target=self._poll_loop, name="model-hot-reload", daemon=True).start()

    def _poll_loop(self) -> None:
        from .inference import SignatureDetector
        from .model_registry import S3ModelRegistry, current_target_version

        while not self._stop.wait(settings.model_poll_seconds):
            try:
                target = current_target_version()
                if target and self.detector is not None and target != self.detector.version:
                    log.info("model alias moved %s -> %s; loading new model", self.detector.version, target)
                    registry = S3ModelRegistry(settings.model_s3_bucket, settings.model_s3_prefix,
                                               settings.model_cache_dir)
                    new_detector = SignatureDetector(registry.fetch(target))  # load BEFORE swapping
                    with self._swap_lock:
                        self.detector = new_detector
                    log.info("hot reload complete: now serving %s", target)
                self.last_reload_error = None
            except Exception as exc:  # keep serving the old model if anything goes wrong
                self.last_reload_error = repr(exc)
                log.exception("hot reload check failed; still serving current model")

    def stop(self) -> None:
        self._stop.set()


models = ModelHolder()


@worker_process_init.connect
def _init_worker_process(**_):
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


@celery_app.task(name=DETECT_TASK, **RETRY_OPTIONS)
def detect_signature(self, image_key: str, threshold: float | None = None,
                     enqueued_at: float | None = None, simulate_failures: int = 0) -> dict:
    started = time.perf_counter()
    try:
        queue_wait_ms = _start(self, enqueued_at, simulate_failures)
        models.ensure_loaded()
        detector = models.detector  # local reference: a hot swap mid-request cannot mix models
        with observability.span("detect", model_version=detector.version, retries=self.request.retries,
                                queue_wait_ms=queue_wait_ms if queue_wait_ms is not None else -1):
            image = _read_image(image_key)
            t0 = time.perf_counter()
            detections = detector.detect(image, threshold)
            inference_ms = (time.perf_counter() - t0) * 1000
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
        "timings_ms": {"queue_wait": queue_wait_ms, "inference": round(inference_ms, 1),
                       "total_worker": round(total_ms, 1)},
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
            raise RuntimeError("similarity is disabled on this worker (ENABLE_SIMILARITY=false)")
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
        "note": ("Siamese ResNet18; threshold validated on held-out writers (CEDAR)." if embedder.version
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
        "worker_pid": os.getpid(),
    }
