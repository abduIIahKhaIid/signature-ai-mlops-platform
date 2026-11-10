"""Serves the React web app (signature_service/web, built into app/static/web by docker/api.Dockerfile).

  /           Detect: upload a document, see signature boxes and confidence
  /verify     Compare two signatures
  /pipeline   Retraining dashboard (falls back to the classic HTML page if the app is not built)

The app only calls the public API (/v1/*, /ready), so it works the same behind any host name.
"""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

WEB_DIR = Path(os.getenv("WEB_DIST_DIR", Path(__file__).with_name("static") / "web"))
SPA_ROUTES = ("/", "/verify")
NO_STORE = {"Cache-Control": "no-store"}


def index_html() -> str | None:
    index = WEB_DIR / "index.html"
    return index.read_text(encoding="utf-8") if index.is_file() else None


def mount(app: FastAPI) -> None:
    if (WEB_DIR / "assets").is_dir():
        # file names carry a content hash, so browsers may cache them for a long time
        app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="web-assets")

    async def spa():
        html = index_html()
        if html is None:  # local run without `npm run build`: the API docs are the front page
            return RedirectResponse("/docs")
        return HTMLResponse(html, headers=NO_STORE)

    for path in SPA_ROUTES:
        app.add_api_route(path, spa, methods=["GET"], include_in_schema=False)

    @app.get("/favicon.svg", include_in_schema=False)
    async def favicon():
        icon = WEB_DIR / "favicon.svg"
        if icon.is_file():
            return FileResponse(icon, media_type="image/svg+xml")
        return HTMLResponse(status_code=404)
