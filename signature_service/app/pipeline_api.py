"""Read-only pipeline status for the live dashboard (/pipeline) + admin actions (token protected)."""
from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse

from .config import settings

router = APIRouter(tags=["retraining pipeline"])
DASHBOARD = Path(__file__).with_name("static") / "pipeline_dashboard.html"


def _store():
    import redis

    from .retrain import PipelineStore

    return PipelineStore(redis.Redis.from_url(settings.broker_url))


@router.get("/pipeline", response_class=HTMLResponse, include_in_schema=False)
async def pipeline_dashboard():
    return HTMLResponse(DASHBOARD.read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})


@router.get("/v1/pipeline/state", summary="Live retraining pipeline state (dashboard data)")
async def pipeline_state(run_id: str | None = Query(default=None, max_length=64)):
    from .retrain import dashboard_state

    def read():
        return dashboard_state(_store(), settings, run_id)

    try:
        return await run_in_threadpool(read)
    except Exception as exc:
        raise HTTPException(503, f"pipeline state unavailable: {exc}") from exc


@router.post("/v1/pipeline/check", status_code=202, summary="Check the HF repo now (admin token)")
async def pipeline_check(force: bool = Query(default=False, description="retrain even if this dataset was trained"),
                         x_admin_token: str | None = Header(default=None)):
    if not settings.pipeline_admin_token:
        raise HTTPException(503, "PIPELINE_ADMIN_TOKEN is not set on the server")
    if not x_admin_token or not hmac.compare_digest(x_admin_token, settings.pipeline_admin_token):
        raise HTTPException(401, "invalid admin token")
    from .celery_app import PIPELINE_CHECK_TASK, celery_app

    def enqueue():
        _store().decide("manual", f"dashboard button: check now{' (force retrain)' if force else ''}", source="manual")
        return celery_app.send_task(PIPELINE_CHECK_TASK, kwargs={"source": "manual", "force": force},
                                    queue=settings.pipeline_queue).id

    task_id = await run_in_threadpool(enqueue)
    return {"queued": True, "task_id": task_id, "force": force}
