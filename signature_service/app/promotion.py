"""Promotion rules shared by the workers (who refuse) and the dashboard (who promotes).

Two S3 aliases per model:
    latest      the newest CANDIDATE. Any training notebook may write it; nothing is served from it in production.
    production  what the workers serve. It may only be written by a validation gate (pipeline notebook, similarity
                notebook) or by an admin through the dashboard (Promote / Roll back). Every such write carries a
                `gate` record for exactly that version.

A worker that follows `production` refuses an alias without a valid gate record and keeps serving its current model,
so a notebook run with the wrong alias name, or an alias written by hand, can never go live by accident.
Following `latest` (local development) is allowed without a record.

Gate record:
    {"version": "<same as the alias>", "passed": true,  "checked_by": "...", "checked_at": "...", "metrics": {...}}
 or {"version": "<same as the alias>", "passed": false, "override": true, "approved_by": "...", "reason": "..."}
"""
from __future__ import annotations

GATED_ALIAS = "production"


class UnapprovedRelease(RuntimeError):
    """The serving alias points to a release without a valid gate record: it is not loaded."""


def gate_problem(alias: dict, alias_name: str | None) -> str | None:
    """Why this alias may not be served (None = it may)."""
    if alias_name != GATED_ALIAS:
        return None
    version = alias.get("version")
    gate = alias.get("gate")
    if not isinstance(gate, dict):
        return (f"alias '{alias_name}' -> {version} has no gate record. '{GATED_ALIAS}' may only be written by a "
                "validation gate or the dashboard's Promote / Roll back; notebooks write candidates to 'latest'")
    if gate.get("version") != version:
        return f"the gate record is for version {gate.get('version')!r}, but the alias points to {version!r}"
    if gate.get("passed") is True:
        return None
    if gate.get("override") is True:
        if not str(gate.get("approved_by") or "").strip() or not str(gate.get("reason") or "").strip():
            return "an override gate record needs approved_by and a reason"
        return None
    reasons = "; ".join(map(str, gate.get("reasons") or [])) or "no reason recorded"
    return f"version {version} did not pass its validation gate ({reasons}) and was not approved by an admin"


def require_gate(alias: dict, alias_name: str | None) -> dict:
    problem = gate_problem(alias, alias_name)
    if problem:
        raise UnapprovedRelease(problem)
    return alias
