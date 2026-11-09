"""Celery application shared by the API (producer) and the worker (consumer).

Importing this module must stay light: the API container does not install torch.
"""
from celery import Celery

from .config import settings

celery_app = Celery("signature", broker=settings.broker_url, backend=settings.result_backend)
celery_app.conf.update(
    task_default_queue=settings.inference_queue,
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    task_track_started=True,           # PENDING -> STARTED -> SUCCESS/FAILURE visible to clients
    task_acks_late=True,               # a crashed worker does not lose the job ...
    task_reject_on_worker_lost=True,   # ... it goes back to the queue
    worker_prefetch_multiplier=1,      # long CPU tasks: do not hoard jobs in one process
    result_expires=settings.result_ttl_seconds,
    task_time_limit=settings.task_time_limit_seconds,
    task_soft_time_limit=max(1, settings.task_time_limit_seconds - 10),
    broker_connection_retry_on_startup=True,
    imports=("app.tasks",),
)

DETECT_TASK = "signature.detect"
VERIFY_TASK = "signature.verify"
MODEL_INFO_TASK = "signature.model_info"
