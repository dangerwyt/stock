import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const job = process.argv[2];
const allowed = new Set(["top50", "accuracy", "global-news", "opening-auction", "market-pulse", "us-etf-map", "teacher-distillation"]);
if (!allowed.has(job)) throw new Error(`Unsupported job: ${job || "missing"}`);

for (const filename of [".env.development.local", ".env.local"]) {
  try {
    const text = await readFile(join(projectRoot, filename), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

if (!process.env.ADMIN_API_TOKEN) throw new Error("ADMIN_API_TOKEN is required");
const baseUrl = String(process.env.LOCAL_SCHEDULER_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const response = await fetch(`${baseUrl}/api/admin/run`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ job }),
  signal: AbortSignal.timeout(180000),
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.message || payload.error || `${job} HTTP ${response.status}`);
console.log(JSON.stringify({
  status: payload.status,
  job,
  meta: payload.result?.meta || null,
  itemCount: payload.result?.items?.length || null,
  accuracy: payload.result?.overall || null,
  evaluation: payload.result?.evaluation || null,
  cycleCounts: payload.result?.cycles ? Object.fromEntries(Object.entries(payload.result.cycles).map(([name, value]) => [name, value.ranking?.length || 0])) : null,
}, null, 2));
