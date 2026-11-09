"""Environment for the whole test session. Must run before any `app` module is imported,
because app.config reads the environment once at import time."""
import os
import socket
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


TMP = Path(tempfile.mkdtemp(prefix="sigsvc-"))
REDIS_PORT = _free_port()
MOTO_PORT = _free_port()
E2E_BUCKET = "e2e-models"
E2E_PREFIX = "signatureai/detection"

os.environ.update({
    "CELERY_BROKER_URL": f"redis://127.0.0.1:{REDIS_PORT}/0",
    "CELERY_RESULT_BACKEND": f"redis://127.0.0.1:{REDIS_PORT}/1",
    "STORAGE_BACKEND": "local",
    "LOCAL_STORAGE_DIR": str(TMP / "uploads"),
    "MODEL_SOURCE": "s3",
    "MODEL_S3_BUCKET": E2E_BUCKET,
    "MODEL_S3_PREFIX": E2E_PREFIX,
    "MODEL_ALIAS": "latest",
    "MODEL_CACHE_DIR": str(TMP / "model-cache"),
    "MODEL_POLL_SECONDS": "2",
    "SIMILARITY_PRETRAINED": "false",  # no internet for ImageNet weights in CI
    "TORCH_THREADS": "1",
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_DEFAULT_REGION": "us-east-1",
    "NO_PROXY": "127.0.0.1,localhost",
    "no_proxy": "127.0.0.1,localhost",
    "LOGFIRE_TOKEN": "",
    "ALLOW_FAILURE_SIMULATION": "true",
    "MAX_RETRIES": "2",
})
