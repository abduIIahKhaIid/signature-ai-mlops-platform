"""Pipeline status for the live dashboard (/pipeline) + admin actions (token protected):
check now, retrain anyway, stop the running training, roll back the served model, alert settings."""
from __future__ import annotations

import hmac
from pathlib import Path

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

from .config import settings

router = APIRouter(tags=["retraining pipeline"])
DASHBOARD = Path(__file__).with_name("static") / "pipeline_dashboard.html"


def _store():
    import redis

    from .retrain import PipelineStore

    return PipelineStore(redis.Redis.from_url(settings.broker_url))


@router.get("/pipeline", response_class=HTMLResponse, include_in_schema=False)
async def pipeline_dashboard():
    from .web import index_html

    # the React app when it is built (Docker image), otherwise the classic single-file dashboard
    html = index_html() or DASHBOARD.read_text(encoding="utf-8")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@router.get("/v1/pipeline/state", summary="Live retraining pipeline state (dashboard data)")
async def pipeline_state(run_id: str | None = Query(default=None, max_length=64)):
    from .retrain import dashboard_state

    def read():
        return dashboard_state(_store(), settings, run_id)

    try:
        return await run_in_threadpool(read)
    except Exception as exc:
        raise HTTPException(503, f"pipeline state unavailable: {exc}") from exc


def _require_admin(token: str | None) -> None:
    if not settings.pipeline_admin_token:
        raise HTTPException(503, "PIPELINE_ADMIN_TOKEN is not set on the server")
    if not token or not hmac.compare_digest(token, settings.pipeline_admin_token):
        raise HTTPException(401, "invalid admin token")


def _who(request: Request) -> str:
    return f"dashboard ({request.client.host if request.client else 'unknown'})"


def _s3():
    import boto3

    return boto3.client("s3")


async def _action(fn, *args):
    from .retrain import ActionError

    try:
        return await run_in_threadpool(fn, *args)
    except ActionError as exc:
        raise HTTPException(409, str(exc)) from exc
    except Exception as exc:  # e.g. S3 AccessDenied: the EC2 role needs the pipeline write permissions
        raise HTTPException(502, f"{type(exc).__name__}: {exc}") from exc


class AlertPrefs(BaseModel):
    email: bool | None = None
    slack: bool | None = None
    stuck: bool | None = None


class TrainingSettings(BaseModel):
    epochs: int | None = Field(default=None, ge=1, le=20, description="max epochs for the next runs; null = default")


@router.post("/v1/pipeline/settings", summary="Set max training epochs for the next runs (admin token)")
async def pipeline_settings(body: TrainingSettings, request: Request, x_admin_token: str | None = Header(default=None)):
    _require_admin(x_admin_token)
    from .retrain import set_training

    return await _action(set_training, _store(), settings, body.epochs, _who(request))


@router.post("/v1/pipeline/stop", status_code=202, summary="Stop the running training run (admin token)")
async def pipeline_stop(request: Request, run_id: str | None = Query(default=None, max_length=64),
                        x_admin_token: str | None = Header(default=None)):
    _require_admin(x_admin_token)
    from .retrain import request_stop

    return await _action(request_stop, _store(), _s3(), settings, run_id, _who(request))


@router.post("/v1/pipeline/rollback", summary="Serve the previous model again (admin token)")
async def pipeline_rollback(request: Request, x_admin_token: str | None = Header(default=None)):
    _require_admin(x_admin_token)
    from .retrain import rollback

    return await _action(rollback, _store(), _s3(), settings, _who(request))


@router.post("/v1/pipeline/alerts", summary="Turn alert types on or off (admin token)")
async def pipeline_alerts(prefs: AlertPrefs, request: Request, x_admin_token: str | None = Header(default=None)):
    _require_admin(x_admin_token)
    from .retrain import set_alerts

    return await _action(set_alerts, _store(), prefs.model_dump(exclude_none=True), _who(request))


@router.post("/v1/pipeline/check", status_code=202, summary="Check the HF repo now (admin token)")
async def pipeline_check(request: Request, force: bool = Query(default=False, description="retrain even if this dataset was trained"),
                         x_admin_token: str | None = Header(default=None)):
    _require_admin(x_admin_token)
    from .celery_app import PIPELINE_CHECK_TASK, celery_app

    def enqueue():
        store = _store()
        store.audit("retrain" if force else "check", "retrain anyway (forced)" if force else "check for new data", _who(request))
        store.decide("manual", f"dashboard button: check now{' (force retrain)' if force else ''}", source="manual")
        return celery_app.send_task(PIPELINE_CHECK_TASK, kwargs={"source": "manual", "force": force},
                                    queue=settings.pipeline_queue).id

    task_id = await run_in_threadpool(enqueue)
    return {"queued": True, "task_id": task_id, "force": force}
