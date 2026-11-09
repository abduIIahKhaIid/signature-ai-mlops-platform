"""Celery tasks of the EC2 retraining orchestrator. They run ONLY in the `pipeline` worker
(queue `pipeline`, concurrency 1, embedded beat), never in the inference workers."""
from __future__ import annotations

from .celery_app import PIPELINE_CHECK_TASK, PIPELINE_TICK_TASK, celery_app

_orchestrator = None


def orchestrator():
    global _orchestrator
    if _orchestrator is None:
        from .retrain import build_orchestrator

        _orchestrator = build_orchestrator()
    return _orchestrator


@celery_app.task(name=PIPELINE_CHECK_TASK, acks_late=False, time_limit=900, soft_time_limit=880)
def check_dataset(source: str = "webhook", hf_sha: str | None = None, force: bool = False, note: str | None = None) -> dict:
    """Is there a new (never trained) dataset ZIP in the HF repo? If so, start a Kaggle retraining run."""
    return orchestrator().request_check(source, hf_sha=hf_sha, force=force, note=note)


@celery_app.task(name=PIPELINE_TICK_TASK, acks_late=False, ignore_result=True, time_limit=900, soft_time_limit=880)
def tick() -> None:
    """Follow the active run (Kaggle + live progress), re-check after a run, fallback HF poll."""
    orchestrator().tick()
