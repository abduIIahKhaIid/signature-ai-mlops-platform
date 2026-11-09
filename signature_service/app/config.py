"""Runtime configuration, read once from environment variables (12-factor style)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


def _float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


@dataclass(frozen=True)
class Settings:
    service_name: str = field(default_factory=lambda: os.getenv("SERVICE_NAME", "signature-service"))
    environment: str = field(default_factory=lambda: os.getenv("ENVIRONMENT", "local"))
    app_version: str = field(default_factory=lambda: os.getenv("APP_VERSION", "dev"))  # git SHA set by the CD deploy

    # Queue
    broker_url: str = field(default_factory=lambda: os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0"))
    result_backend: str = field(default_factory=lambda: os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/1"))
    inference_queue: str = field(default_factory=lambda: os.getenv("INFERENCE_QUEUE", "inference"))
    result_ttl_seconds: int = field(default_factory=lambda: _int("RESULT_TTL_SECONDS", 3600))
    task_time_limit_seconds: int = field(default_factory=lambda: _int("TASK_TIME_LIMIT_SECONDS", 120))
    sync_wait_max_seconds: float = field(default_factory=lambda: _float("SYNC_WAIT_MAX_SECONDS", 30))
    max_retries: int = field(default_factory=lambda: _int("MAX_RETRIES", 3))
    # Demo / test switch: lets a request ask the worker to fail N times before succeeding,
    # to show RETRY -> SUCCESS and RETRY -> FAILURE live. Keep false in production.
    allow_failure_simulation: bool = field(default_factory=lambda: _bool("ALLOW_FAILURE_SIMULATION", False))

    # Uploaded image storage shared by API and workers: "local" (shared volume) or "s3"
    storage_backend: str = field(default_factory=lambda: os.getenv("STORAGE_BACKEND", "local"))
    local_storage_dir: str = field(default_factory=lambda: os.getenv("LOCAL_STORAGE_DIR", "/data/uploads"))
    uploads_s3_bucket: str | None = field(default_factory=lambda: os.getenv("UPLOADS_S3_BUCKET"))
    uploads_s3_prefix: str = field(default_factory=lambda: os.getenv("UPLOADS_S3_PREFIX", "signatureai/uploads"))
    max_upload_bytes: int = field(default_factory=lambda: _int("MAX_UPLOAD_BYTES", 10 * 1024 * 1024))
    max_image_pixels: int = field(default_factory=lambda: _int("MAX_IMAGE_PIXELS", 40_000_000))

    # Detection model registry (same layout the training notebook writes)
    model_source: str = field(default_factory=lambda: os.getenv("MODEL_SOURCE", "s3"))  # s3 | local
    model_s3_bucket: str | None = field(default_factory=lambda: os.getenv("MODEL_S3_BUCKET"))
    model_s3_prefix: str = field(default_factory=lambda: os.getenv("MODEL_S3_PREFIX", "signatureai/detection"))
    model_alias: str | None = field(default_factory=lambda: os.getenv("MODEL_ALIAS", "production"))
    model_version: str | None = field(default_factory=lambda: os.getenv("MODEL_VERSION") or None)
    model_cache_dir: str = field(default_factory=lambda: os.getenv("MODEL_CACHE_DIR", "/models"))
    local_model_dir: str | None = field(default_factory=lambda: os.getenv("LOCAL_MODEL_DIR"))
    model_poll_seconds: int = field(default_factory=lambda: _int("MODEL_POLL_SECONDS", 300))  # 0 disables hot reload

    # Inference
    detection_threshold: float = field(default_factory=lambda: _float("DETECTION_THRESHOLD", 0.5))
    torch_threads: int = field(default_factory=lambda: _int("TORCH_THREADS", 2))
    enable_similarity: bool = field(default_factory=lambda: _bool("ENABLE_SIMILARITY", True))
    similarity_pretrained: bool = field(default_factory=lambda: _bool("SIMILARITY_PRETRAINED", True))
    similarity_weights_path: str | None = field(default_factory=lambda: os.getenv("SIMILARITY_WEIGHTS_PATH"))
    similarity_match_threshold: float = field(default_factory=lambda: _float("SIMILARITY_MATCH_THRESHOLD", 0.80))
    # Siamese weights from S3 (written by notebooks/02_similarity_siamese_kaggle.ipynb): alias "latest" -> versions/<v>/siamese_resnet18.pt.
    # When set, the alias' validated threshold replaces SIMILARITY_MATCH_THRESHOLD.
    similarity_s3_alias: str | None = field(default_factory=lambda: os.getenv("SIMILARITY_S3_ALIAS") or None)
    similarity_s3_prefix: str = field(default_factory=lambda: os.getenv("SIMILARITY_S3_PREFIX", "signatureai/similarity"))

    # Which Celery worker this process is: "inference" loads the models, "pipeline" (retraining orchestrator) does not.
    worker_role: str = field(default_factory=lambda: os.getenv("WORKER_ROLE", "inference"))

    # Retraining pipeline trigger: HF webhook -> EC2 orchestrator ("ec2", default) or GitHub Actions ("github")
    retrain_backend: str = field(default_factory=lambda: os.getenv("RETRAIN_BACKEND", "ec2"))
    hf_webhook_secret: str | None = field(default_factory=lambda: os.getenv("HF_WEBHOOK_SECRET") or None)
    hf_dataset_repo: str | None = field(default_factory=lambda: os.getenv("HF_DATASET_REPO") or None)
    github_repo: str | None = field(default_factory=lambda: os.getenv("GITHUB_REPO") or None)  # owner/name
    github_token: str | None = field(default_factory=lambda: os.getenv("GITHUB_TOKEN") or None)
    retrain_mode: str = field(default_factory=lambda: os.getenv("RETRAIN_MODE", "full"))
    retrain_cooldown_seconds: int = field(default_factory=lambda: _int("RETRAIN_COOLDOWN_SECONDS", 1800))

    # EC2 retraining orchestrator (pipeline worker): HF dataset check -> dedup -> Kaggle GPU -> monitor -> hot reload
    pipeline_queue: str = field(default_factory=lambda: os.getenv("PIPELINE_QUEUE", "pipeline"))
    pipeline_dir: str = field(default_factory=lambda: os.getenv("PIPELINE_DIR", "/srv/pipeline"))  # kaggle_job.py + notebook
    pipeline_work_dir: str = field(default_factory=lambda: os.getenv("PIPELINE_WORK_DIR", "/data/pipeline"))
    pipeline_tick_seconds: int = field(default_factory=lambda: _int("PIPELINE_TICK_SECONDS", 15))
    pipeline_poll_minutes: int = field(default_factory=lambda: _int("PIPELINE_POLL_MINUTES", 30))  # 0 = webhook only
    pipeline_debounce_seconds: int = field(default_factory=lambda: _int("PIPELINE_DEBOUNCE_SECONDS", 45))
    pipeline_max_auto_attempts: int = field(default_factory=lambda: _int("PIPELINE_MAX_AUTO_ATTEMPTS", 2))
    pipeline_max_run_hours: float = field(default_factory=lambda: _float("PIPELINE_MAX_RUN_HOURS", 12))
    pipeline_admin_token: str | None = field(default_factory=lambda: os.getenv("PIPELINE_ADMIN_TOKEN") or None)
    gate_min_test_map50: float = field(default_factory=lambda: _float("GATE_MIN_TEST_MAP50", 0.75))
    gate_max_regression: float = field(default_factory=lambda: _float("GATE_MAX_REGRESSION", 0.02))
    hf_token: str | None = field(default_factory=lambda: os.getenv("HF_TOKEN") or None)
    kaggle_username: str | None = field(default_factory=lambda: os.getenv("KAGGLE_USERNAME") or None)
    kaggle_kernel_slug: str = field(default_factory=lambda: os.getenv("KAGGLE_KERNEL_SLUG", "signatureai-retrain"))
    kaggle_secrets_slug: str = field(default_factory=lambda: os.getenv("KAGGLE_SECRETS_SLUG", "signatureai-pipeline-secrets"))
    kaggle_accelerator: str = field(default_factory=lambda: os.getenv("KAGGLE_ACCELERATOR", "NvidiaTeslaT4"))

    # Observability
    logfire_token: str | None = field(default_factory=lambda: os.getenv("LOGFIRE_TOKEN"))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))


settings = Settings()
