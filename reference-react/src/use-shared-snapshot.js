import { useEffect, useState } from "react";

const requests = new Map();
export function fetchSharedSnapshot(url, fetchImpl = fetch) {
  const existing = requests.get(url);
  if (existing && (existing.pending || Date.now() - existing.at < 1000)) return existing.promise;
  const entry = { pending: true, at: Date.now() };
  entry.promise = fetchImpl(url, { cache: "no-cache", signal: AbortSignal.timeout(20000) })
    .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
    .finally(() => { entry.pending = false; entry.at = Date.now(); });
  requests.set(url, entry);
  // Dynamic search/detail URLs must not accumulate forever.
  if (requests.size > 100) for (const [key, value] of requests) {
    if (!value.pending && key !== url) requests.delete(key);
    if (requests.size <= 80) break;
  }
  return entry.promise;
}

export function useSharedSnapshot(url, refreshMs = 0, fallbackUrl = null) {
  const [result, setResult] = useState({ snapshot: null, state: "loading", sourceMode: "loading" });
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const load = async () => {
      const id = ++sequence;
      try {
        const data = await fetchSharedSnapshot(url);
        if (active && sequence === id) setResult({ snapshot: data, state: "ready", sourceMode: data?.meta?.sourceMode || "live" });
      } catch {
        if (!active || sequence !== id) return;
        if (fallbackUrl) try {
          const data = await fetchSharedSnapshot(fallbackUrl);
          if (active && sequence === id) setResult({ snapshot: data, state: "fallback", sourceMode: "demo" });
          return;
        } catch { /* Retain the last displayed snapshot with an unavailable state. */ }
        if (active && sequence === id) setResult((old) => ({ ...old, state: "unavailable", sourceMode: "unavailable" }));
      }
    };
    load();
    const visibleLoad = () => { if (!document.hidden) void load(); };
    const timer = refreshMs ? setInterval(visibleLoad, refreshMs) : null;
    document.addEventListener("visibilitychange", visibleLoad);
    return () => { active = false; sequence += 1; clearInterval(timer); document.removeEventListener("visibilitychange", visibleLoad); };
  }, [url, refreshMs, fallbackUrl]);
  return result;
}
