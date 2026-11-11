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
    # Abuse protection: new detect/verify jobs per client IP per minute (0 = off). Requests that carry the
    # admin token (X-Admin-Token = PIPELINE_ADMIN_TOKEN) are not limited, e.g. your own Locust stress test.
    rate_limit_per_minute: int = field(default_factory=lambda: _int("RATE_LIMIT_PER_MINUTE", 30))

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
    detection_threshold: float = field(default_factory=lambda: _float("DETECTION_THRESHOLD", 0.1))  # decision threshold
    torch_threads: int = field(default_factory=lambda: _int("TORCH_THREADS", 2))
    enable_similarity: bool = field(default_factory=lambda: _bool("ENABLE_SIMILARITY", True))
    similarity_pretrained: bool = field(default_factory=lambda: _bool("SIMILARITY_PRETRAINED", True))
    similarity_weights_path: str | None = field(default_factory=lambda: os.getenv("SIMILARITY_WEIGHTS_PATH"))
    # A model release (detector version, or similarity version + SHA-256) that failed to download/verify/load is not
    # tried again for this long, so a broken alias does not re-download ~45-80 MB every MODEL_POLL_SECONDS.
    # Moving the alias to another release is tried at once.
    failed_release_retry_seconds: int = field(default_factory=lambda: _int("FAILED_RELEASE_RETRY_SECONDS", 3600))
    # /v1/detect: with 2+ signatures on a page, compare every pair of the top N crops with the similarity model
    compare_max_signatures: int = field(default_factory=lambda: _int("COMPARE_MAX_SIGNATURES", 10))
    similarity_match_threshold: float = field(default_factory=lambda: _float("SIMILARITY_MATCH_THRESHOLD", 0.80))
    # Siamese weights from S3 (written by notebooks/03_similarity_same_dataset_kaggle.ipynb): alias "latest" -> versions/<v>/siamese_resnet18.pt.
    # When set, the alias' validated threshold replaces SIMILARITY_MATCH_THRESHOLD.
    similarity_s3_alias: str | None = field(default_factory=lambda: os.getenv("SIMILARITY_S3_ALIAS") or None)
    similarity_s3_prefix: str = field(default_factory=lambda: os.getenv("SIMILARITY_S3_PREFIX", "signatureai/similarity"))

    # Which Celery worker this process is: "inference" loads the models, "pipeline" (retraining orchestrator) does not.
    worker_role: str = field(default_factory=lambda: os.getenv("WORKER_ROLE", "inference"))

    # Retraining pipeline trigger: HF webhook -> EC2 orchestrator (pipeline worker) -> Kaggle GPU. No GitHub Actions.
    hf_webhook_secret: str | None = field(default_factory=lambda: os.getenv("HF_WEBHOOK_SECRET") or None)
    hf_dataset_repo: str | None = field(default_factory=lambda: os.getenv("HF_DATASET_REPO") or None)
    retrain_mode: str = field(default_factory=lambda: os.getenv("RETRAIN_MODE", "full"))
    # max training epochs; empty = the mode's default (smoke 1, full 8). The dashboard setting overrides this.
    retrain_epochs: int | None = field(default_factory=lambda: int(os.getenv("RETRAIN_EPOCHS")) if os.getenv("RETRAIN_EPOCHS", "").strip() else None)

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
    # Overfitting check: reject if validation mAP@50 exceeds test mAP@50 by more than this
    gate_max_val_test_gap: float = field(default_factory=lambda: _float("GATE_MAX_VAL_TEST_GAP", 0.05))
    # Comet project that retraining runs log to (kept separate from the first manual training runs)
    comet_project: str = field(default_factory=lambda: os.getenv("COMET_PROJECT", "signature-ai-detection-retrain"))
    hf_token: str | None = field(default_factory=lambda: os.getenv("HF_TOKEN") or None)
    kaggle_username: str | None = field(default_factory=lambda: os.getenv("KAGGLE_USERNAME") or None)
    kaggle_kernel_slug: str = field(default_factory=lambda: os.getenv("KAGGLE_KERNEL_SLUG", "signatureai-retrain"))
    kaggle_secrets_slug: str = field(default_factory=lambda: os.getenv("KAGGLE_SECRETS_SLUG", "signatureai-pipeline-secrets"))
    kaggle_accelerator: str = field(default_factory=lambda: os.getenv("KAGGLE_ACCELERATOR", "NvidiaTeslaT4"))
    pipeline_stuck_minutes: int = field(default_factory=lambda: _int("PIPELINE_STUCK_MINUTES", 10))

    # Comet: the dashboard reads the run's experiment (metrics, parameters, console, files) through the REST API,
    # and the same key + workspace are synced to the Kaggle secrets before every run.
    comet_api_key: str | None = field(default_factory=lambda: os.getenv("COMET_API_KEY") or None)
    comet_workspace: str | None = field(default_factory=lambda: os.getenv("COMET_WORKSPACE") or None)
    comet_base_url: str = field(default_factory=lambda: os.getenv("COMET_BASE_URL", "https://www.comet.com"))

    # S3 keys the KAGGLE NOTEBOOK uses (it runs outside AWS, so it cannot use the EC2 role). When these and the
    # Comet/HF keys are set, the orchestrator refreshes the private Kaggle secrets dataset before every run, so the
    # secrets live in one place (this .env) and can never drift apart.
    notebook_aws_access_key_id: str | None = field(default_factory=lambda: os.getenv("NOTEBOOK_AWS_ACCESS_KEY_ID") or None)
    notebook_aws_secret_access_key: str | None = field(default_factory=lambda: os.getenv("NOTEBOOK_AWS_SECRET_ACCESS_KEY") or None)
    notebook_aws_region: str | None = field(default_factory=lambda: os.getenv("NOTEBOOK_AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or None)

    # Alerts (dashboard toggles decide which ones are sent)
    # Public address of this server, used for links in alerts. PUBLIC_URL, else https://<PUBLIC_HOST> (Caddy), else none.
    public_url: str | None = field(default_factory=lambda: os.getenv("PUBLIC_URL") or (
        f"https://{os.getenv('PUBLIC_HOST')}" if os.getenv("PUBLIC_HOST") else None))
    alert_webhook_url: str | None = field(default_factory=lambda: os.getenv("ALERT_WEBHOOK_URL") or None)  # Slack/Discord
    smtp_host: str | None = field(default_factory=lambda: os.getenv("SMTP_HOST") or None)
    smtp_port: int = field(default_factory=lambda: _int("SMTP_PORT", 587))
    smtp_user: str | None = field(default_factory=lambda: os.getenv("SMTP_USER") or None)
    smtp_password: str | None = field(default_factory=lambda: os.getenv("SMTP_PASSWORD") or None)
    alert_email_to: str | None = field(default_factory=lambda: os.getenv("ALERT_EMAIL_TO") or None)
    alert_email_from: str | None = field(default_factory=lambda: os.getenv("ALERT_EMAIL_FROM") or None)

    # Observability
    logfire_token: str | None = field(default_factory=lambda: os.getenv("LOGFIRE_TOKEN"))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))


settings = Settings()
