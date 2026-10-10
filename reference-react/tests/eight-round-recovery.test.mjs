import test from "node:test";
import assert from "node:assert/strict";
import { collectionSnapshotState, runScheduled, evaluatePredictionsJob, validatedDailySnapshot, collectNewsJob, readSourceQuality, scheduledJobPlan } from "../worker/index.js";
import { assessCollectionDay, assessTradingDay } from "../scripts/trading-day-acceptance.mjs";

function kv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { values, get: async (key) => values.get(key) || null, put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key), list: async ({ prefix }) => ({ keys: [...values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}
const table = (rows) => Response.json({ code: 0, data: { fields: Object.keys(rows[0] || {}), items: rows.map(Object.values) } });
const at = (time) => Date.parse(`2026-09-09T${time}:00+08:00`);

test("eight-round freshness follows due rounds, retains original times and never claims realtime", () => {
  const snapshot = { meta: { generatedAt: new Date(at("14:00")).toISOString(), status: "ready" }, items: [{}] };
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:22"), true).status, "scheduled");
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:49"), true).status, "scheduled");
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:50"), true).status, "overdue");
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:22"), true).nextTime, "17:40");
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:22"), undefined).status, "unknown");
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:22"), true).realtime, false);
  assert.equal(snapshot.meta.generatedAt, new Date(at("14:00")).toISOString());
  assert.equal(collectionSnapshotState(snapshot, "news", at("17:22"), false).nextTime, "22:00");
});

test("relay is counted once per round and partial local data never becomes cloud completion", async () => {
  const stamp = new Date(at("10:30")).toISOString();
  const STOCK_STATE = kv({ "trade-calendar:2026-09-09": { isOpen: true },
    "market:latest": { meta: { generatedAt: stamp, status: "partial" }, quotes: [{}] },
    "news:latest": { meta: { generatedAt: stamp, status: "ready" }, items: [{}] },
    "collection-relay:market": { generatedAt: stamp, syncedAt: stamp },
    "collection-relay:news": { generatedAt: stamp, syncedAt: stamp } });
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" };
  const never = () => { throw new Error("No supplier calls expected for relayed snapshots"); };
  const first = await runScheduled(env, at("10:31"), never);
  const second = await runScheduled(env, at("10:33"), never);
  assert.equal(first.results.find((item) => item.name === "market-pulse").status, "partial");
  assert.equal(second.results.length, 0);
  const jobs = [...STOCK_STATE.values.keys()].filter((key) => key.startsWith("job:2026-09-09:"));
  assert.equal(jobs.length, 2);
  const market = JSON.parse(STOCK_STATE.values.get("job:2026-09-09:10:30:market-pulse"));
  assert.equal(market.completedAt, undefined);
  assert.equal(market.sourceGeneratedAt, stamp);
});

test("failed maturity dates do not block valid dates or overwrite frozen predictions", async () => {
  const forecast = (id, date) => ({ id, predictionId: id, tradeDate: "2026-09-04", maturityTradeDate: date, status: "pending", evidenceCompleteness: "complete",
    code: "600001", tsCode: "600001.SH", cycle: "超短", horizon: "1d", referencePrice: 10, probabilityUp: 0.6, predictedDirection: "up", topAgents: [] });
  const missing = forecast("missing", "2026-09-07"), valid = forecast("valid", "2026-09-08");
  const STOCK_STATE = kv({ "prediction:missing": missing, "prediction:valid": valid,
    "prediction-due:2026-09-07": [missing.id], "prediction-due:2026-09-08": [valid.id] });
  const result = await evaluatePredictionsJob({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" }, at("17:40"), async (_url, init) => {
    const date = JSON.parse(init.body).params.trade_date;
    return table(date === "20260907" ? [] : [{ ts_code: "600001.SH", trade_date: date, open: 10, high: 12, low: 9, close: 11 }]);
  });
  assert.equal(result.status, "partial");
  assert.equal(result.overall.sampleCount, 1);
  assert.equal(result.overall.hitRate, null);
  assert.deepEqual(result.evaluation.failedDates, ["2026-09-07"]);
  assert.equal(result.evaluation.missingCloseQueueCount, 1);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("prediction:valid")), valid);
});

test("validated daily cache is reused with source time and empty primary switches to backup", async () => {
  const env = { STOCK_STATE: kv(), TUSHARE_PRIMARY_TOKEN: "fixture", TUSHARE_FALLBACK_API_KEY: "fixture", TUSHARE_FALLBACK_URL: "https://fallback.test" };
  let calls = 0;
  const fetcher = async (_url, init) => { calls += 1; return table(init.method === "POST" ? [] : [{ ts_code: "600001.SH", trade_date: "20260909", open: 10, high: 11, low: 9, close: 10 }]); };
  const first = await validatedDailySnapshot(env, "2026-09-09", at("17:40"), fetcher);
  const second = await validatedDailySnapshot(env, "2026-09-09", at("17:42"), fetcher);
  assert.equal(calls, 2);
  assert.equal(first.provider, "ProMax");
  assert.deepEqual(second, first);
});

test("stale backup news is rejected and source quality does not report it as ready", async () => {
  const STOCK_STATE = kv();
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" };
  await assert.rejects(collectNewsJob(env, async () => table([{ title: "央行降准与股票市场", url: "https://example.test/news", pub_time: "2026-01-01 10:00:00" }])), /stale/);
  assert.equal(STOCK_STATE.values.has("news:latest"), false);
  const report = await readSourceQuality(env);
  assert.ok(report.endpoints.length > 0);
  assert.ok(report.endpoints.every((item) => item.status !== "ready"));
});

test("fresh ISO news timestamps retain timezone and healthy source observations", async () => {
  const STOCK_STATE = kv();
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" };
  const stamp = new Date().toISOString();
  const result = await collectNewsJob(env, async () => table([{ title: "央行降准支持银行信贷与资本市场", src: "新浪财经", url: "https://example.test/financial-news", pub_time: stamp }]));
  assert.equal(result.items[0].publishedAt, stamp);
  const report = await readSourceQuality(env);
  assert.ok(report.endpoints.every((item) => item.status === "ready"));
});

test("eight-round acceptance cannot reuse old observations or erase strict historical failures", () => {
  const date = "2026-09-09";
  const rows = [];
  for (let minute = 440; minute <= 1335; minute += 1) {
    const time = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    const plan = scheduledJobPlan(at(time), true);
    rows.push({ date, time, at: new Date(at(time)).toISOString(), tradingDay: true, collectionPolicy: "eight-rounds-v1", collectionErrors: [],
      errors: ["Market not live during trading session"], budgetUsed: 2, budgetLimit: 200, pipeline: { tradeDate: date, frozenCount: 800 },
      jobs: plan.jobs.map((name) => ({ name, slot: plan.slot, status: "completed" })) });
  }
  assert.equal(assessCollectionDay(rows, date).status, "passed");
  assert.equal(assessTradingDay(rows, date).status, "failed");
  assert.equal(assessCollectionDay(rows.map((row) => ({ ...row, collectionPolicy: null })), date).status, "pending");
  assert.equal(assessCollectionDay(rows.slice(10), date).status, "failed");
  const gaps = rows.filter((row) => row.time < "10:00" || row.time > "10:10");
  assert.equal(assessCollectionDay(gaps, date).status, "failed");
  rows[10].jobs.push({ name: "market-close", status: "partial" });
  assert.equal(assessCollectionDay(rows, date).status, "failed");
});
