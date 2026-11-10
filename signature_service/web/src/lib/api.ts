// Typed client for the SignatureAI FastAPI service (same origin in production, Vite proxy in development).

export type JobStatus = "PENDING" | "STARTED" | "RETRY" | "SUCCESS" | "FAILURE";

export interface Detection {
  label: string;
  score: number;
  box_xyxy: [number, number, number, number];
}

export interface DetectResult {
  model_version: string;
  image_size: { width: number; height: number };
  signature_count: number;
  detections: Detection[];
  timings_ms: { queue_wait: number | null; inference: number; total_worker: number };
  retries: number;
  worker_pid: number;
}

export interface VerifySide {
  detection: Detection | null;
  used_full_image: boolean;
  image_size: { width: number; height: number };
}

export interface VerifyResult {
  similarity: number;
  score_percent: number;
  match: boolean;
  threshold: number;
  similarity_model: string;
  similarity_version: string | null;
  detector_version: string;
  reference: VerifySide;
  candidate: VerifySide;
  note: string;
  timings_ms: { queue_wait: number | null; total_worker: number };
  retries: number;
}

export interface JobBody<T> {
  job_id: string;
  status: JobStatus;
  result?: T;
  error?: string;
  retry_reason?: string;
  poll_url?: string;
}

export interface ModelInfo {
  detector_version: string;
  detector_load_seconds: number;
  similarity_model: string | null;
  similarity_version: string | null;
  similarity_threshold: number;
  cold_start_seconds: number;
  worker_uptime_seconds: number;
  hot_reload_poll_seconds: number;
  last_reload_error: string | null;
  worker_pid: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff"];
export const MAX_UPLOAD_MB = 10; // server default MAX_UPLOAD_BYTES (10 MiB)

/** Turns an HTTP status + server text into one sentence that says what to do next. */
export function explain(status: number, detail: string): string {
  if (status === 415) return "This file type is not supported. Upload a JPEG, PNG, WEBP, BMP or TIFF image.";
  if (status === 413) return "The file is too large for the server. Upload a smaller or compressed image.";
  if (status === 422) return "The server could not read this file as an image. Check that it opens on your computer, then upload it again.";
  if (status === 429) return "Too many images were sent from your network in the last minute. Wait a minute, then try again.";
  if (status === 503) return "No model worker is online right now. Wait a minute for the workers to start, then try again.";
  if (status === 0) return "The server could not be reached. Check your connection and that the API is running.";
  return detail || `The server answered with HTTP ${status}.`;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    return body.error || body.detail || body.reason || JSON.stringify(body);
  } catch {
    return res.statusText;
  }
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, explain(0, ""));
  }
  if (!res.ok) {
    const detail = await readError(res);
    throw new ApiError(res.status, explain(res.status, detail));
  }
  return res.json() as Promise<T>;
}

export interface JobTrace {
  submittedAt: number; // ms, client clock: request sent
  acceptedAt?: number; // upload finished, job id received
  startedAt?: number; // first poll that saw STARTED
  finishedAt?: number; // first poll that saw SUCCESS / FAILURE
  retries: number;
  status: JobStatus | "UPLOADING";
}

/**
 * Submit a job (multipart form) and poll /v1/jobs/{id} until it is final.
 * onTrace is called on every status change so the UI can draw the queue journey live.
 */
export async function runJob<T>(
  url: string,
  form: FormData,
  onTrace: (t: JobTrace) => void,
  signal?: AbortSignal,
): Promise<{ result: T; trace: JobTrace }> {
  const trace: JobTrace = { submittedAt: performance.now(), retries: 0, status: "UPLOADING" };
  onTrace({ ...trace });
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: form, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, explain(0, ""));
  }
  if (res.status !== 200 && res.status !== 202) {
    throw new ApiError(res.status, explain(res.status, await readError(res)));
  }
  let body = (await res.json()) as JobBody<T>;
  trace.acceptedAt = performance.now();
  const update = (b: JobBody<T>) => {
    const now = performance.now();
    if (b.status === "STARTED" && !trace.startedAt) trace.startedAt = now;
    if (b.status === "RETRY") trace.retries += 1;
    if ((b.status === "SUCCESS" || b.status === "FAILURE") && !trace.finishedAt) trace.finishedAt = now;
    if (b.status !== trace.status) {
      trace.status = b.status;
      onTrace({ ...trace });
    }
  };
  update(body);
  const deadline = performance.now() + 180_000;
  while (body.status !== "SUCCESS" && body.status !== "FAILURE") {
    if (performance.now() > deadline) throw new ApiError(504, "The job did not finish within 3 minutes. The queue may be very busy; try again shortly.");
    await new Promise((r) => setTimeout(r, 350));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const poll = await fetch(`/v1/jobs/${body.job_id}`, { signal });
    body = (await poll.json()) as JobBody<T>;
    update(body);
  }
  if (body.status === "FAILURE" || !body.result) {
    const invalid = (body.error || "").includes("InvalidImage");
    throw new ApiError(invalid ? 422 : 500, invalid ? explain(422, "") : `The worker could not finish the job: ${body.error}`);
  }
  return { result: body.result, trace };
}

export function detectForm(file: File): FormData {
  const f = new FormData();
  f.append("file", file, file.name);
  return f;
}

export function verifyForm(reference: File, candidate: File): FormData {
  const f = new FormData();
  f.append("reference", reference, reference.name);
  f.append("candidate", candidate, candidate.name);
  return f;
}
