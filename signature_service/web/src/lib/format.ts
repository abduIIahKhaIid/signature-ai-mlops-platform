export const pct = (x: number | null | undefined, digits = 0) =>
  typeof x === "number" && isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "—";

export const num4 = (x: unknown) => (typeof x === "number" && isFinite(x) ? x.toFixed(4) : "—");

export const int = (x: unknown) => (typeof x === "number" && isFinite(x) ? Math.round(x).toLocaleString() : "—");

export function ms(x: number | null | undefined): string {
  if (typeof x !== "number" || !isFinite(x)) return "—";
  if (x < 1000) return `${Math.round(x)} ms`;
  return `${(x / 1000).toFixed(x < 10_000 ? 2 : 1)} s`;
}

export function bytes(b: number | null | undefined): string {
  if (typeof b !== "number") return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (b >= 1000 && i < 3) {
    b /= 1000;
    i++;
  }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const t = (v?: string | null) => (v ? Date.parse(v) : NaN);

export function ago(v?: string | null): string {
  const time = t(v);
  if (isNaN(time)) return "—";
  const s = Math.max(0, (Date.now() - time) / 1000);
  if (s < 60) return `${Math.round(s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
  return new Date(time).toLocaleString();
}

export function duration(a?: string | null, b?: string | null): string {
  const start = t(a);
  const end = b ? t(b) : Date.now();
  const s = (end - start) / 1000;
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function clock(v?: string | null): string {
  const time = t(v);
  return isNaN(time) ? "" : new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
}

export const short = (s?: string | null, n = 12) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : "—");

/** Colour band for a detection confidence, used consistently on boxes, bars and list rows. */
export function confidenceBand(score: number): { label: string; tone: "verified" | "marker" | "caution" } {
  if (score >= 0.8) return { label: "High", tone: "verified" };
  if (score >= 0.5) return { label: "Medium", tone: "marker" };
  return { label: "Low", tone: "caution" };
}

/** "v20261109T142002Z-8a4d7444" -> "9 Nov 2026, 14:20 UTC" (model versions carry their training time). */
export function versionDate(v?: string | null): string | null {
  const m = v && /v(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}, ${m[4]}:${m[5]} UTC`;
}
