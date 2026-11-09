"""Logging + optional Pydantic Logfire tracing.

If LOGFIRE_TOKEN is set, FastAPI requests, Celery tasks and Redis calls are traced and
sent to Logfire; otherwise everything still works and logs go to stdout only.
"""
from __future__ import annotations

import contextlib
import logging
import sys

from .config import settings

log = logging.getLogger("signature")
_logfire = None


def setup(role: str) -> None:
    """Call once per process. role: 'api' or 'worker'."""
    global _logfire
    logging.basicConfig(
        level=settings.log_level,
        stream=sys.stdout,
        format="%(asctime)s %(levelname)s [" + role + "] %(name)s: %(message)s",
    )
    if not settings.logfire_token:
        log.info("Logfire disabled (LOGFIRE_TOKEN not set); logging to stdout only")
        return
    try:
        import logfire
    except ImportError:
        log.warning("LOGFIRE_TOKEN set but logfire is not installed")
        return
    logfire.configure(
        token=settings.logfire_token,
        service_name=f"{settings.service_name}-{role}",
        environment=settings.environment,
        send_to_logfire="if-token-present",
        console=False,  # stdout already has our log lines; avoid printing everything twice
    )
    logging.getLogger().addHandler(logfire.LogfireLoggingHandler())
    logfire.instrument_celery()
    logfire.instrument_redis()
    try:  # CPU %, memory, swap of the container -> Logfire "Basic System Metrics" dashboard
        logfire.instrument_system_metrics(base="basic")
    except Exception as exc:  # optional extra not installed
        log.warning("system metrics disabled: %s", exc)
    _logfire = logfire
    log.info("Logfire enabled for %s", role)


def instrument_fastapi(app) -> None:
    if _logfire is not None:
        _logfire.instrument_fastapi(app)


def span(name: str, **attributes):
    """Logfire span when enabled, otherwise a no-op context manager."""
    if _logfire is not None:
        return _logfire.span(name, **attributes)
    return contextlib.nullcontext()
