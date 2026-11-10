// Shape of GET /v1/pipeline/state (signature_service/app/retrain.py: dashboard_state)

export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStatus = "running" | "deploying" | "succeeded" | "approved" | "rejected" | "failed" | "succeeded_reload_pending";

export interface PhaseDef { key: string; label: string; where: string }
export interface PhaseState { status: PhaseStatus; started_at?: string; ended_at?: string; detail?: string }
export interface RunEvent { ts: string; level: "info" | "warning" | "error"; source: string; message: string }

export interface Epoch {
  epoch: number;
  train_loss?: number;
  val_loss?: number;
  val_map50?: number;
  val_map?: number;
  epoch_seconds?: number;
}

export interface Gate {
  passed?: boolean;
  floor?: number;
  max_regression?: number;
  max_val_test_gap?: number;
  baseline_test_map50?: number | null;
  reasons?: string[];
}

export interface Overfitting {
  best_epoch?: number;
  val_map50?: number | null;
  test_map50?: number | null;
  val_test_gap?: number | null;
  max_val_test_gap?: number;
  passed?: boolean;
  train_loss?: number | null;
  val_loss?: number | null;
  loss_ratio?: number | null;
  val_loss_rose_after_best?: boolean;
}

export interface RunResult {
  version?: string;
  status?: string;
  test_map50?: number;
  test_map?: number;
  recommended_threshold?: number;
  gate?: Gate;
  overfitting?: Overfitting;
  deploy_alias?: string;
  s3_model_uri?: string;
  comet_url?: string;
}

export interface DatasetSummary {
  source_images?: number;
  valid_images?: number;
  exact_removed?: number;
  exact_cross_split_removed?: number;
  near_confirmed_pairs?: number;
  after_leakage_quarantine?: number;
  after_exact_dedupe?: number;
  leakage_gate_passed?: boolean;
  final_splits?: Record<string, { images?: number; boxes?: number }>;
}

export interface LiveData {
  dataset?: { sha256?: string; sha256_verified?: boolean };
  dataset_summary?: DatasetSummary;
  test_metrics?: { map_50?: number; map?: number; mar_100?: number };
  calibration?: { threshold?: number; precision?: number; recall?: number };
  result?: RunResult;
  comet_url?: string;
}

export interface Progress { desc: string; n: number; total: number; rate?: number; postfix?: string }

export interface Run {
  id: string;
  status: RunStatus;
  created_at: string;
  finished_at?: string | null;
  mode: string;
  trigger: { source: string; hf_sha?: string; force?: boolean; note?: string };
  dataset: {
    repo: string; commit: string; url: string; zip: string; size_bytes: number; sha256?: string; fingerprint: string;
    committed_at?: string; commit_title?: string; other_zips?: string[];
  };
  kaggle: { kernel?: string; url?: string; version?: number; status?: string; message?: string };
  phases: Record<string, PhaseState>;
  events: RunEvent[];
  live?: { current?: { label?: string }; progress?: Progress[]; epochs?: Epoch[]; max_epochs?: number; gpu?: { name?: string; allocated_gb?: number }; data?: LiveData; updated_at?: string } | null;
  result?: RunResult | null;
  error?: string | null;
  log_tail?: string | null;
  served_before?: string | null;
  served_after?: string | null;
}

export interface RunSummary {
  id: string; status: RunStatus; created_at: string; finished_at?: string | null; trigger?: string; zip?: string;
  fingerprint?: string; version?: string; gate_status?: string; test_map50?: number; champion_map50?: number; error?: string;
}

export interface Decision { ts: string; decision: string; message: string; source?: string; run_id?: string }

export interface PipelineState {
  server_time: string;
  phases: PhaseDef[];
  orchestrator: { backend: string; online: boolean; last_heartbeat: string | null };
  config: {
    hf_repo?: string; hf_url?: string; mode: string; deploy_alias: string; poll_minutes: number; gate_floor: number;
    gate_max_regression: number; gate_max_val_test_gap?: number; comet_project?: string; kaggle_url?: string; accelerator: string; admin_enabled: boolean; s3_prefix: string;
  };
  active_run_id: string | null;
  run: Run | null;
  runs: RunSummary[];
  decisions: Decision[];
  serving: { worker?: { detector_version?: string }; worker_error?: string; alias?: { version?: string }; alias_name?: string; checked_at?: string } | null;
  last_check: { ts: string; source: string; commit: string; zips: { path: string }[]; url: string } | null;
  pending_recheck: boolean;
}

export const RUN_STATUS: Record<string, { label: string; tone: "live" | "good" | "warn" | "bad" }> = {
  running: { label: "Running", tone: "live" },
  deploying: { label: "Deploying to EC2", tone: "live" },
  succeeded: { label: "New model live", tone: "good" },
  approved: { label: "Approved, not deployed", tone: "warn" },
  rejected: { label: "Rejected, current model kept", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  succeeded_reload_pending: { label: "Deployed, reload pending", tone: "warn" },
};

export const DECISION: Record<string, { label: string; tone: "live" | "good" | "warn" | "bad" | "plain" }> = {
  started: { label: "Run started", tone: "good" },
  skipped_trained: { label: "Already trained", tone: "plain" },
  no_dataset: { label: "No dataset ZIP", tone: "warn" },
  deferred: { label: "Queued after run", tone: "live" },
  blocked: { label: "Blocked", tone: "bad" },
  error: { label: "Error", tone: "bad" },
  skipped_failed: { label: "Not retried", tone: "warn" },
  webhook: { label: "Webhook", tone: "live" },
  manual: { label: "Dashboard", tone: "live" },
};

export const TONE_PILL = {
  live: "bg-signal-soft text-signal",
  good: "bg-verified-soft text-verified",
  warn: "bg-caution-soft text-caution",
  bad: "bg-fault-soft text-fault",
  plain: "bg-desk text-ink-soft",
} as const;
