"""Small read-only Comet REST client used by the pipeline dashboard (no comet_ml dependency on EC2).

The dashboard shows the run's Comet experiment (metrics, parameters, console output, files) without anyone
signing in to Comet: the pipeline worker reads it with COMET_API_KEY and stores a summary in Redis.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

HISTORY_METRICS = ("train_loss", "val_loss", "val_map50")


class CometError(RuntimeError):
    pass


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


class CometClient:
    def __init__(self, api_key: str, base_url: str = "https://www.comet.com", timeout: float = 15):
        self.api_key = api_key
        self.base = base_url.rstrip("/") + "/api/rest/v2"
        self.timeout = timeout

    def _get(self, path: str, **params):
        url = f"{self.base}/{path.lstrip('/')}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        request = urllib.request.Request(url, headers={"Authorization": self.api_key, "Accept": "application/json",
                                                       "User-Agent": "signatureai-pipeline"})
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read() or b"null")
        except urllib.error.HTTPError as exc:
            raise CometError(f"Comet API {path}: HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise CometError(f"Comet API {path}: {exc.reason}") from exc

    def workspaces(self) -> list[str]:
        body = self._get("workspaces")
        if isinstance(body, dict):
            body = body.get("workspaceNames") or body.get("workspaces") or []
        return [w if isinstance(w, str) else w.get("name") for w in body or []]

    def experiment(self, key: str) -> dict:
        summary = (self._get("experiment/metrics/summary", experimentKey=key) or {}).get("values") or []
        params = (self._get("experiment/parameters", experimentKey=key) or {}).get("values") or []
        try:
            output = (self._get("experiment/output", experimentKey=key) or {}).get("output") or ""
        except CometError:
            output = ""
        try:
            assets = (self._get("experiment/asset/list", experimentKey=key) or {}).get("assets") or []
        except CometError:
            assets = []
        metrics = []
        for m in summary:
            name = m.get("name")
            item = {"name": name, "latest": _num(m.get("valueCurrent")), "max": _num(m.get("valueMax")),
                    "min": _num(m.get("valueMin")), "step": m.get("stepCurrent") or m.get("stepMax")}
            if name in HISTORY_METRICS:
                try:
                    points = (self._get("experiment/metrics/get-metric", experimentKey=key, metricName=name) or {}).get("metrics") or []
                    item["history"] = [_num(p.get("metricValue")) for p in points][-50:]
                except CometError:
                    item["history"] = []
            metrics.append(item)
        lines = [ln.rstrip() for ln in output.replace("\r", "\n").split("\n") if ln.strip()]
        return {
            "metrics": sorted(metrics, key=lambda m: (m["name"] or "")),
            "params": {p.get("name"): p.get("valueCurrent") for p in params if p.get("name")},
            "console": lines[-80:],
            "assets": [{"name": a.get("fileName"), "type": a.get("type"), "size": a.get("fileSize")} for a in assets][:60],
        }
