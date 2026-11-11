// Shape of GET /v1/pipeline/state (signature_service/app/retrain.py: dashboard_state)

export type PhaseStatus = "pending" | "running" | "done" | "failed" | "skipped" | "stopped";
export type RunStatus = "running" | "deploying" | "succeeded" | "approved" | "rejected" | "failed" | "stopped" | "succeeded_reload_pending";

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
  learning_rate?: number;
}

export interface Gate {
  passed?: boolean;
  floor?: number;
  max_regression?: number;
  max_val_test_gap?: number;
  baseline_test_map50?: number | null;
  baseline_test_metrics?: Record<string, number> | null;
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
  best_val_map50?: number;
  epochs_completed?: number;
  init_version?: string;
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
  comet_url?: string | null;
  comet_key?: string | null;
  dataset_summary?: DatasetSummary;
  test_metrics?: { map_50?: number; map?: number; mar_100?: number };
  calibration?: { threshold?: number; precision?: number; recall?: number };
  result?: RunResult;
}

export interface Progress { desc: string; n: number; total: number; rate?: number; postfix?: string }

export interface CometMetric { name: string; latest?: number | null; max?: number | null; min?: number | null; step?: number | null; history?: (number | null)[] }

export interface CometInfo {
  enabled?: boolean;
  key?: string | null;
  url?: string | null;
  workspace?: string | null;
  project?: string | null;
  metrics?: CometMetric[];
  params?: Record<string, string>;
  console?: string[];
  assets?: { name?: string; type?: string; size?: number }[];
  error?: string | null;
  fetched_at?: string;
}

export interface TrainingSettings {
  epochs: number;
  source: string;
  mode: string;
  mode_default: number;
  env_epochs?: number | null;
  max_epochs: number;
  seconds_per_epoch: number;
}

export interface Run {
  id: string;
  status: RunStatus;
  created_at: string;
  finished_at?: string | null;
  mode: string;
  epochs?: number;
  trigger: { source: string; hf_sha?: string; force?: boolean; note?: string };
  dataset: {
    repo: string; commit: string; url: string; zip: string; size_bytes: number; sha256?: string; fingerprint: string;
    committed_at?: string; commit_title?: string; other_zips?: string[];
  };
  kaggle: { kernel?: string; url?: string; version?: number; status?: string; message?: string };
  phases: Record<string, PhaseState>;
  events: RunEvent[];
  live?: {
    current?: string | null; progress?: Progress[]; epochs?: Epoch[]; max_epochs?: number; status?: string;
    gpu?: { name?: string; allocated_gb?: number; reserved_gb?: number }; data?: LiveData; updated_at?: string;
    console?: { ts: string; line: string; stream?: string }[];
  } | null;
  comet?: CometInfo;
  stop_requested_at?: string | null;
  stop_requested_by?: string | null;
  result?: RunResult | null;
  error?: string | null;
  log_tail?: string | null;
  served_before?: string | null;
  served_after?: string | null;
}

export interface RunSummary {
  id: string; status: RunStatus; created_at: string; finished_at?: string | null; trigger?: string; zip?: string;
  fingerprint?: string; version?: string; gate_status?: string; test_map50?: number; champion_map50?: number; error?: string;
  mode?: string; best_val_map50?: number | null; val_test_gap?: number | null; epochs?: number | null;
  duration_seconds?: number | null; kaggle_version?: number | null; comet_url?: string | null; test_map?: number | null;
  threshold?: number | null;
}

export interface LineageModel { version: string; source: string; run_id?: string; dataset?: string; dataset_sha256?: string; test_map50?: number; created_at?: string }

export interface AuditEntry { ts: string; action: string; detail: string; who: string }

export interface Decision { ts: string; decision: string; message: string; source?: string; run_id?: string }

export interface PipelineState {
  server_time: string;
  phases: PhaseDef[];
  orchestrator: { backend: string; online: boolean; last_heartbeat: string | null };
  config: {
    hf_repo?: string; hf_url?: string; mode: string; deploy_alias: string; poll_minutes: number; gate_floor: number;
    gate_max_regression: number; gate_max_val_test_gap?: number; comet_project?: string; kaggle_url?: string; accelerator: string; admin_enabled: boolean; s3_prefix: string;
    comet_workspace?: string | null; comet_enabled?: boolean; comet_project_url?: string | null; model_poll_seconds?: number;
  };
  eta?: { remaining_seconds: number; finish_at: string; basis: "history" | "defaults"; runs_used: number } | null;
  previous_dataset?: { run_id: string; zip?: string; summary: DatasetSummary } | null;
  lineage?: { base: string; models: LineageModel[]; serving?: string | null; current?: { run_id: string; status: RunStatus; version?: string | null; dataset?: string; dataset_sha256?: string } | null };
  audit?: AuditEntry[];
  rollback_to?: string | null;
  kaggle_quota?: { used_hours?: number; total_hours?: number; remaining_hours?: number; refresh_at?: string | null; error?: string } | null;
  training?: TrainingSettings;
  alerts?: { channels: { email: boolean; slack: boolean }; prefs: { email: boolean; slack: boolean; stuck: boolean; trigger?: boolean } };
  last_webhook_at?: string | null;
  active_run_id: string | null;
  run: Run | null;
  runs: RunSummary[];
  decisions: Decision[];
  serving: { worker?: { detector_version?: string }; worker_error?: string; alias?: { version?: string; previous_version?: string; stage?: string }; alias_name?: string; checked_at?: string } | null;
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
  stopped: { label: "Stopped by you", tone: "bad" },
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
