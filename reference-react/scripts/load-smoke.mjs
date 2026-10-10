import { pathToFileURL } from "node:url";
import { validateContract } from "./api-contracts.mjs";

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export async function runLoadSmoke({ baseUrl, total = 200, concurrency = 20, p95LimitMs = 500, paths = ["/api/status", "/api/market", "/api/top50", "/api/news", "/api/accuracy", "/api/operations"], fetchImpl = fetch }) {
  let next = 0;
  const results = [];
  const startedAt = Date.now();
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (next < total) {
      const index = next;
      next += 1;
      const path = paths[index % paths.length];
      const started = Date.now();
      try {
        const response = await fetchImpl(new URL(path, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (response.ok) validateContract(path, await response.json());
        results.push({ path, status: response.status, elapsedMs: Date.now() - started });
      } catch (error) {
        results.push({ path, status: 0, elapsedMs: Date.now() - started, error: error.message });
      }
    }
  }));
  const failures = results.filter((item) => item.status < 200 || item.status >= 300).length;
  const endpoints = Object.fromEntries(paths.map((path) => {
    const entries = results.filter((item) => item.path === path);
    return [path, {
      requests: entries.length,
      success: entries.filter((item) => item.status >= 200 && item.status < 300).length,
      serverErrors: entries.filter((item) => item.status >= 500).length,
      p50Ms: percentile(entries.map((item) => item.elapsedMs), 0.5),
      p95Ms: percentile(entries.map((item) => item.elapsedMs), 0.95),
    }];
  }));
  const p95Ms = percentile(results.map((item) => item.elapsedMs), 0.95);
  const summary = {
    total: results.length,
    failures,
    maxStatus: Math.max(...results.map((item) => item.status)),
    averageMs: Math.round(results.reduce((sum, item) => sum + item.elapsedMs, 0) / Math.max(1, results.length)),
    p50Ms: percentile(results.map((item) => item.elapsedMs), 0.5),
    p95Ms,
    p95LimitMs,
    endpoints,
    durationMs: Date.now() - startedAt,
  };
  if (failures) throw new Error(`load smoke failed: ${failures}/${summary.total} requests returned errors`);
  if (p95Ms > p95LimitMs) throw new Error(`load smoke failed: P95 ${p95Ms}ms exceeds ${p95LimitMs}ms`);
  return summary;
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runLoadSmoke({
    baseUrl: argument("--base", "http://127.0.0.1:4173"),
    total: Number(argument("--total", 200)),
    concurrency: Number(argument("--concurrency", 20)),
    p95LimitMs: Number(argument("--p95", 500)),
  });
  console.log(JSON.stringify(result, null, 2));
}
