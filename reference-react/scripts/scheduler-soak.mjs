import { pathToFileURL } from "node:url";
import { validateContract } from "./api-contracts.mjs";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function runSoakChecks({ baseUrl, iterations, intervalMs = 60000, maxSchedulerStagnantChecks = 10, fetchImpl = fetch, now = Date.now }) {
  const paths = ["/api/status", "/api/market", "/api/news", "/api/top50", "/api/operations", "/api/notifications"];
  let previousSchedulerAt = null;
  let schedulerStagnantChecks = 0;
  const previousSnapshots = new Map();
  const notificationStates = new Map();
  let checks = 0;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const path of paths) {
      const response = await fetchImpl(new URL(path, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
      const body = await response.json();
      validateContract(path, body);
      if (path === "/api/status") {
        const schedulerAt = body?.health?.scheduler?.lastRunAt || null;
        if (previousSchedulerAt && schedulerAt && Date.parse(schedulerAt) < Date.parse(previousSchedulerAt)) throw new Error("scheduler timestamp regressed");
        const age = now() - Date.parse(schedulerAt);
        if (age < -60000 || age > 5 * 60000) throw new Error("scheduler timestamp is stale or in the future");
        if (previousSchedulerAt && schedulerAt === previousSchedulerAt) schedulerStagnantChecks += 1;
        else if (schedulerAt) schedulerStagnantChecks = 0;
        if (schedulerStagnantChecks > maxSchedulerStagnantChecks) throw new Error("scheduler timestamp did not advance");
        previousSchedulerAt = schedulerAt || previousSchedulerAt;
      }
      const snapshotAt = path === "/api/market" || path === "/api/news" || path === "/api/top50"
        ? body?.meta?.generatedAt
        : path === "/api/operations" ? body?.generatedAt : null;
      const previousSnapshotAt = previousSnapshots.get(path);
      if (previousSnapshotAt && snapshotAt && Date.parse(snapshotAt) < Date.parse(previousSnapshotAt)) throw new Error(`${path} snapshot timestamp regressed`);
      if (snapshotAt) previousSnapshots.set(path, snapshotAt);
      if (path === "/api/market" && body.health.status === "live") {
        if (!body.quotes.length || body.quotes.some((quote) => {
          const text = String(quote.observedAt || quote.time || "");
          const at = Date.parse(/^\d{4}-\d{2}-\d{2} \d/.test(text) ? text.replace(" ", "T") + "+08:00" : text);
          return !Number.isFinite(at) || now() - at > 15 * 60000 || at > now() + 60000;
        })) throw new Error("live market has missing or stale quote timestamps");
      }
      if (path === "/api/operations") {
        const ai = body?.components?.ai;
        if (Number(ai?.queueDepth) > 0 && Number(ai?.snapshotAgeMs) > 15 * 60 * 1000) throw new Error("AI queue appears stuck");
      }
      if (path === "/api/notifications") {
        const currentNotifications = new Map();
        for (const item of body?.items || []) {
          const signature = `${item.type || ""}:${item.title || ""}:${item.level || ""}`;
          if (currentNotifications.has(signature)) continue;
          currentNotifications.set(signature, item.id);
          const previousId = notificationStates.get(signature);
          if (iteration > 0 && previousId && previousId !== item.id && ["critical", "important"].includes(item.level)) throw new Error("duplicate operational alert detected");
        }
        notificationStates.clear();
        currentNotifications.forEach((id, signature) => notificationStates.set(signature, id));
      }
      checks += 1;
    }
    if (iteration + 1 < iterations && intervalMs > 0) await delay(intervalMs);
  }
  return { status: "passed", iterations, checks, lastSchedulerAt: previousSchedulerAt };
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const minutes = Number(argument("--minutes", 10));
  const hours = Number(argument("--hours", 0));
  const intervalMs = Number(argument("--interval-ms", 60000));
  const durationMs = hours > 0 ? hours * 60 * 60 * 1000 : minutes * 60000;
  const iterations = Math.max(1, Math.floor(durationMs / Math.max(1, intervalMs)));
  const result = await runSoakChecks({ baseUrl: argument("--base", "http://127.0.0.1:4173"), iterations, intervalMs });
  console.log(JSON.stringify(result, null, 2));
}
