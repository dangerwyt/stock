import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { accuracyGateErrors } from "./api-contracts.mjs";

export function assessTradingDay(records, date) {
  const dayRows = records.filter((row) => row.date === date);
  const rows = dayRows.some((row) => row.tradingDay === true) ? dayRows.sort((a, b) => a.at.localeCompare(b.at)) : [];
  const reasons = [];
  if (!rows.length) return { date, status: "pending", observations: 0, reasons: ["No verified trading-day observations"] };
  if (rows[0].time > "07:35") reasons.push("Pre-market observation missing");
  const jobs = rows.flatMap((row) => row.jobs || []);
  if (jobs.some((job) => ["failed", "partial", "interrupted"].includes(job.status))) reasons.push("A scheduled task failed or was interrupted during the day");
  if (rows.some((row) => row.errors?.length)) reasons.push("API or freshness failure observed");
  if (rows.some((row) => !Number.isFinite(row.budgetUsed) || !Number.isFinite(row.budgetLimit))) reasons.push("AI budget evidence missing");
  if (rows.some((row) => row.budgetUsed > row.budgetLimit)) reasons.push("AI budget exceeded");
  if (rows.at(-1).time < "18:45") return { date, status: reasons.length ? "failed" : "in_progress", observations: rows.length, reasons };
  for (const [start, end] of [["09:25", "11:35"], ["12:55", "15:20"]]) {
    const window = rows.filter((row) => row.time >= start && row.time <= end);
    const stamps = [Date.parse(`${date}T${start}:00+08:00`), ...window.map((row) => Date.parse(row.at)), Date.parse(`${date}T${end}:00+08:00`)];
    if (stamps.some((stamp, i) => i && stamp - stamps[i - 1] > 5 * 60000)) reasons.push(`Monitoring gap in ${start}-${end}`);
    if (window.some((row) => row.errors?.length)) reasons.push(`API or freshness failure in ${start}-${end}`);
  }
  for (const name of ["top50", "opening-auction", "market-pulse", "accuracy", "post-close", "market-close"]) {
    if (!jobs.some((job) => job.name === name && job.status === "completed")) reasons.push(`Missing completed job: ${name}`);
  }
  if (!rows.some((row) => row.pipeline?.tradeDate === date && row.pipeline.frozenCount > 0)) reasons.push("No frozen predictions for this trading day");
  return { date, status: reasons.length ? "failed" : "passed", observations: rows.length, reasons: [...new Set(reasons)] };
}

export function assessCollectionDay(records, date) {
  const rows = records.filter((row) => row.date === date && row.collectionPolicy === "eight-rounds-v1").sort((a, b) => a.at.localeCompare(b.at));
  const reasons = [];
  if (!rows.length) return { date, policy: "eight-rounds-v1", status: "pending", reasons: ["No observations under the eight-round policy"] };
  if (rows.every((row) => row.tradingDay === false)) return { date, policy: "eight-rounds-v1", status: "pending", reasons: ["Non-trading day does not count"] };
  if (rows[0].time > "07:20") reasons.push("Full-day pre-market observation missing");
  if (rows.some((row) => row.tradingDay !== true)) reasons.push("Trading calendar not verified for every observation");
  if (rows.some((row) => row.collectionErrors?.length)) reasons.push("API, scheduled collection or evidence failure observed");
  if (rows.some((row) => !Number.isFinite(row.budgetUsed) || !Number.isFinite(row.budgetLimit) || row.budgetUsed > row.budgetLimit)) reasons.push("AI budget missing or exceeded");
  const jobs = rows.flatMap((row) => row.jobs || []);
  if (jobs.some((job) => ["failed", "partial", "interrupted"].includes(job.status))) reasons.push("A task failed or remained incomplete; historical failures retained");
  if (rows.at(-1).time < "22:15") return { date, policy: "eight-rounds-v1", status: reasons.length ? "failed" : "in_progress", reasons };
  const window = rows.filter((row) => row.time >= "07:20" && row.time <= "22:15");
  const stamps = [Date.parse(`${date}T07:20:00+08:00`), ...window.map((row) => Date.parse(row.at)), Date.parse(`${date}T22:15:00+08:00`)];
  if (stamps.some((stamp, i) => i > 0 && stamp - stamps[i - 1] > 5 * 60000)) reasons.push("Monitoring gap exceeds five minutes");
  const required = { "07:20": ["us-etf-map", "global-news", "market-close", "top50"], "09:26": ["opening-auction", "global-news"],
    "10:30": ["market-pulse", "intraday-news"], "11:35": ["market-pulse", "intraday-news", "midday-review"],
    "13:05": ["market-pulse", "intraday-news"], "14:00": ["market-pulse", "intraday-news"],
    "17:40": ["market-close", "post-close", "accuracy", "global-news"], "22:00": ["global-news", "market-close", "post-close", "accuracy"] };
  for (const [slot, names] of Object.entries(required)) for (const name of names) {
    if (!jobs.some((job) => job.slot === slot && job.name === name && job.status === "completed")) reasons.push(`Missing completed round task: ${slot} ${name}`);
  }
  if (!rows.some((row) => row.pipeline?.tradeDate === date && row.pipeline.frozenCount > 0)) reasons.push("Frozen prediction evidence missing");
  return { date, policy: "eight-rounds-v1", status: reasons.length ? "failed" : "passed", observations: rows.length, reasons };
}

export async function observeAcceptance(baseUrl, directory, fetchImpl = fetch, now = Date.now()) {
  const at = new Date(now).toISOString();
  const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(now));
  const [date, time] = clock.split(" ");
  const paths = ["acceptance", "market", "news", "operations", "accuracy"];
  const data = {};
  const errors = [];
  await Promise.all(paths.map(async (path) => {
    try {
      const response = await fetchImpl(new URL(`/api/${path}`, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      data[path] = await response.json();
    } catch (error) { errors.push(`${path}: ${error.message}`); }
  }));
  const tradingDay = data.acceptance?.tradingDay ?? null;
  errors.push(...accuracyGateErrors(data.accuracy));
  const collectionErrors = [...errors];
  const delivery = data.operations?.delivery;
  const collectionPolicy = delivery?.length === 2 && delivery.every((feed) => feed.policy === "eight-rounds-v1") ? "eight-rounds-v1" : null;
  if (collectionPolicy) for (const feed of delivery) {
    if (["missing", "overdue", "partial", "unknown"].includes(feed.status)) collectionErrors.push(`${feed.name}: ${feed.status}`);
  }
  const active = tradingDay === true && ((time >= "09:35" && time <= "11:30") || (time >= "13:05" && time <= "15:00"));
  if (active) {
    if (data.market?.health?.status !== "live") errors.push("Market not live during trading session");
    if (!data.market?.quotes?.length) errors.push("Market quotes missing");
    const newsAge = now - Date.parse(data.news?.meta?.generatedAt || "");
    if (!Number.isFinite(newsAge) || newsAge > 15 * 60000) errors.push("News snapshot missing or older than 15 minutes");
  }
  const schedulerAge = now - Date.parse(data.acceptance?.schedulerAt || "");
  if (tradingDay && (!Number.isFinite(schedulerAge) || schedulerAge > 5 * 60000)) errors.push("Scheduler heartbeat missing or delayed");
  if ((data.acceptance?.matureSampleCount || 0) < 30 && data.acceptance?.accuracyPublished) errors.push("Accuracy published below sample gate");
  if (tradingDay && (!Number.isFinite(schedulerAge) || schedulerAge > 5 * 60000)) collectionErrors.push("Scheduler heartbeat missing or delayed");
  if ((data.acceptance?.matureSampleCount || 0) < 30 && data.acceptance?.accuracyPublished) collectionErrors.push("Accuracy published below sample gate");
  const row = { at, date, time, target: new URL(baseUrl).host, tradingDay, errors,
    collectionPolicy, collectionErrors, delivery: delivery || null,
    jobs: data.acceptance?.jobs || [], pipeline: data.acceptance?.pipeline || null,
    marketDate: data.market?.meta?.tradeDate || null, marketStatus: data.market?.health?.status || null,
    newsAt: data.news?.meta?.generatedAt || null, newsFallback: data.news?.meta?.fallbackActive ?? null,
    matureSampleCount: data.acceptance?.matureSampleCount || 0,
    budgetUsed: data.operations?.aiBudget?.usedCalls ?? null, budgetLimit: data.operations?.aiBudget?.callLimit ?? null };
  await mkdir(directory, { recursive: true });
  const logPath = join(directory, `${date}-${new URL(baseUrl).hostname}.jsonl`);
  await appendFile(logPath, JSON.stringify(row) + "\n", { mode: 0o600 });
  const rows = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const reportPath = logPath.replace(/\.jsonl$/, ".report.json");
  await writeFile(`${reportPath}.tmp`, JSON.stringify(assessTradingDay(rows, date), null, 2), { mode: 0o600 });
  await rename(`${reportPath}.tmp`, reportPath);
  const collectionReportPath = logPath.replace(/\.jsonl$/, ".collection-report.json");
  await writeFile(`${collectionReportPath}.tmp`, JSON.stringify(assessCollectionDay(rows, date), null, 2), { mode: 0o600 });
  await rename(`${collectionReportPath}.tmp`, collectionReportPath);
  return { target: row.target, errors, tradingDay, reportPath };
}
