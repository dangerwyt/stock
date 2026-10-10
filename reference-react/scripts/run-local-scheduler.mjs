import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { observeAcceptance } from "./trading-day-acceptance.mjs";
import { syncLocalSnapshots } from "./sync-local-snapshots.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

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
const localUrl = String(process.env.LOCAL_SCHEDULER_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
const targets = [...new Set([localUrl, process.env.SITES_SCHEDULER_BASE_URL].filter(Boolean))];
for (const baseUrl of targets) {
  try {
    if (baseUrl !== localUrl) {
      try {
        const sync = await syncLocalSnapshots({ stateFile: join(projectRoot, ".local-data/stock-state.json"),
          checkpointFile: join(projectRoot, ".local-data/cloud-sync-checkpoint.json"), baseUrl, token: process.env.ADMIN_API_TOKEN });
        if (sync.imported.length) console.log(JSON.stringify({ at: new Date().toISOString(), target: new URL(baseUrl).host, sync }));
      } catch (error) { console.error(JSON.stringify({ at: new Date().toISOString(), stage: "snapshot-sync", error: error.name })); }
    }
    const response = await fetch(`${baseUrl}/api/admin/scheduled`, {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ notify: baseUrl === localUrl }),
      signal: AbortSignal.timeout(180000),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`scheduler HTTP ${response.status}`);
    if (payload.result?.results?.length) console.log(JSON.stringify({
      at: new Date().toISOString(), target: new URL(baseUrl).host,
      tradingDay: payload.result.tradingDay,
      results: payload.result.results.map(({ name, status }) => ({ name, status })),
    }));
  } catch (error) {
    // Do not retry an uncertain write; the next minute uses persisted job locks.
    console.error(JSON.stringify({ at: new Date().toISOString(), target: new URL(baseUrl).host, error: error.name }));
  }
  const observation = await observeAcceptance(baseUrl, join(projectRoot, ".local-data", "acceptance"));
  if (observation.errors.length) console.error(JSON.stringify(observation));
}
