import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "./api";

/** Fetch JSON now and every `everyMs` while the tab is visible. */
export function usePolling<T>(url: string | null, everyMs: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;

  const load = useCallback(async () => {
    const current = urlRef.current;
    if (!current) return;
    try {
      const body = await getJson<T>(current, { cache: "no-store" });
      if (urlRef.current === current) {
        setData(body);
        setError(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    load();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, everyMs);
    return () => window.clearInterval(id);
  }, [url, everyMs, load]);

  return { data, error, loading, reload: load };
}

/** Object URL for a File, revoked automatically. */
export function useObjectUrl(file: File | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return reduced;
}
