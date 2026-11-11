# Screenshots

| File | Shows | Used in |
|---|---|---|
| `pipeline_dashboard_live_training.png` | `/pipeline` while a retraining run trains on Kaggle: every phase live, cleaning report, event log, trigger decisions | evidence for Phase 10 (continuous training) |
| `pipeline_dashboard_rejected.png` | a run whose model failed the validation gate (test mAP@50 below the 0.75 floor): the served model is kept, the duplicate upload is skipped (*Already trained*) | evidence for the validation gate and duplicate protection |

Both come from **smoke runs on a 76-image test ZIP**, so the mAP values in them are near 0 by design; they show the
pipeline behaviour, not model quality. Model quality is in [`../results/`](../results/) and the root README.

Removed: `pipeline_dashboard_deployed.png` showed a 0.0000 mAP model being *deployed* (taken before the 0.75 floor of
the gate existed). It contradicted the current gate and was not linked from any document.

## Still to add (Phase 8 evidence, names expected by `../results/phase8_observability.md`)
`logfire_trace_detect.png`, `logfire_queue_wait.png`, `logfire_retry.png`, `logfire_failure.png`,
`logfire_system_metrics.png`, `logfire_sql_latency.png`. How to produce each one: `phase8_observability.md`, section 3.

Phase 9 (`signature_service/loadtest/report.py`) writes its charts here as `<run-name>_*.png`.
