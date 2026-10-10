import assert from "node:assert/strict";
import test from "node:test";
import { buildTop50Snapshot, evaluatePredictionsJob, generateTop50Job, marketSnapshotState } from "../worker/index.js";

function memory() {
  const values = new Map();
  return { values, get: async (key) => values.get(key) ?? null,
    put: async (key, value) => values.set(key, value), delete: async (key) => values.delete(key),
    list: async ({ prefix = "" } = {}) => ({ keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}
const response = (fields, items) => Response.json({ code: 0, data: { fields, items } });
const fields = ["ts_code", "trade_date", "open", "high", "low", "close"];
test("lunch and outdated intraday quotes never masquerade as closing prices", () => {
  const market = { meta: { provider: "ProMax rt_k", tradeDate: "2026-09-08", generatedAt: "2026-09-08T03:30:00Z" }, quotes: [] };
  assert.match(marketSnapshotState(market, { session: "lunch" }, null, Date.parse("2026-09-08T04:00:00Z")).label, /非收盘/);
  assert.match(marketSnapshotState(market, { session: "closed" }, null, Date.parse("2026-09-08T08:00:00Z")).label, /尚无可核验/);
  market.meta.generatedAt = "2026-09-08T07:01:00Z";
  assert.equal(marketSnapshotState(market, { session: "closed" }, null, Date.parse("2026-09-08T08:00:00Z")).label, "今日收盘行情快照");
});
function pendingFixture() {
  const STOCK_STATE = memory();
  const forecast = { id: "guard-test", predictionId: "guard-test", tradeDate: "2026-09-07", maturityTradeDate: "2026-09-08",
    status: "pending", evidenceCompleteness: "complete", code: "600001", tsCode: "600001.SH", cycle: "超短", horizon: "1d",
    referencePrice: 10, probabilityUp: 0.6, predictedDirection: "up", topAgents: [] };
  STOCK_STATE.values.set("prediction:guard-test", JSON.stringify(forecast));
  STOCK_STATE.values.set("prediction-due:2026-09-08", JSON.stringify([forecast.id]));
  return { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture", TUSHARE_PRIMARY_API_URL: "https://primary.test" };
}

test("intraday validation performs no provider calls or evidence writes", async () => {
  const env = pendingFixture();
  const before = [...env.STOCK_STATE.values];
  const result = await evaluatePredictionsJob(env, Date.parse("2026-09-08T07:09:00Z"), () => { throw new Error("must not fetch"); });
  assert.equal(result.status, "pending");
  assert.deepEqual([...env.STOCK_STATE.values], before);
});

test("wrong date, missing date and inconsistent OHLC cannot become successful evaluations", async () => {
  for (const row of [["600001.SH", "", 10, 11, 9, 11], ["600001.SH", "20260907", 10, 11, 9, 11], ["600001.SH", "20260908", 10, 9, 8, 11]]) {
    const env = pendingFixture();
    const result = await evaluatePredictionsJob(env, Date.parse("2026-09-08T07:10:00Z"), async () => response(fields, [row]));
    assert.equal(result.status, "partial");
    assert.deepEqual(result.evaluation.failedDates, ["2026-09-08"]);
    assert.equal(env.STOCK_STATE.values.has("prediction-events:guard-test"), false);
    assert.equal(result.overall.sampleCount, 0);
  }
});

test("invalid primary closes use verified fallback and retain exact evaluation evidence without rewriting forecast", async () => {
  const env = { ...pendingFixture(), TUSHARE_FALLBACK_URL: "https://fallback.test", TUSHARE_FALLBACK_API_KEY: "fixture" };
  const original = env.STOCK_STATE.values.get("prediction:guard-test");
  const result = await evaluatePredictionsJob(env, Date.parse("2026-09-08T07:10:00Z"), async (url) => response(fields,
    [["600001.SH", String(url).includes("fallback") ? "20260908" : "20260907", 10, 11, 9, 9.5]]));
  assert.equal(result.overall.sampleCount, 1);
  assert.equal(result.overall.hitRate, null);
  assert.equal(result.recentEvaluations[0].hit, false);
  const patch = JSON.parse(env.STOCK_STATE.values.get("prediction-events:guard-test"))[0].patch;
  assert.equal(patch.evaluationEvidence.provider, "ProMax");
  assert.equal(patch.evaluationEvidence.close, 9.5);
  assert.equal(patch.evaluationEvidence.tradeDate, "2026-09-08");
  assert.equal(env.STOCK_STATE.values.get("prediction:guard-test"), original);
});

test("missing closes remain retryable and never count as hits or inferred suspensions", async () => {
  const env = pendingFixture();
  const result = await evaluatePredictionsJob(env, Date.parse("2026-09-08T07:10:00Z"), async () => response(fields, []));
  assert.equal(result.overall.sampleCount, 0);
  assert.equal(result.evaluation.missingCloseQueueCount, 1);
  assert.equal(env.STOCK_STATE.values.has("prediction-events:guard-test"), false);
});

test("stale daily data cannot generate or overwrite a premarket ranking", async () => {
  const STOCK_STATE = memory();
  const previous = JSON.stringify({ meta: { tradeDate: "2026-09-07" } });
  STOCK_STATE.values.set("top50:latest", previous);
  const fetcher = async (_url, init) => {
    const { api_name } = JSON.parse(init.body);
    if (api_name === "trade_cal") return response(["cal_date", "is_open", "pretrade_date"], [["20260908", 1, "20260907"]]);
    if (api_name === "daily" || api_name === "daily_basic") return response(fields, Array.from({ length: 60 }, (_, i) => [`${600000+i}.SH`, "20260904", 10, 11, 9, 10]));
    return response([], []);
  };
  await assert.rejects(generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" }, Date.parse("2026-09-07T23:35:00Z"), fetcher), /目标交易日/);
  assert.equal(STOCK_STATE.values.get("top50:latest"), previous);
  assert.equal([...STOCK_STATE.values.keys()].some((key) => key.startsWith("prediction:")), false);
});

test("new predictions freeze price and tie rules without claiming calibrated probabilities", () => {
  const { ledger } = buildTop50Snapshot([{ ts_code: "600001.SH", close: 10, trade_date: "20260907" }], "2026-09-08", ["2026-09-09"]);
  assert.deepEqual(ledger.forecasts[0].evaluationRule, { version: "close-direction-v1", priceBasis: "unadjusted", flatDirection: "up", earliestEvaluationTime: "15:10", referenceDate: "2026-09-07" });
});

test("a missing previous-day field uses only verified open calendar dates", async () => {
  const STOCK_STATE = memory();
  const codes = Array.from({ length: 50 }, (_, i) => `${600000+i}.SH`);
  const fetcher = async (_url, init) => {
    const { api_name, params } = JSON.parse(init.body);
    if (api_name === "trade_cal") return response(["cal_date", "is_open", "pretrade_date"], [["20260906", 0, ""], ["20260907", 1, ""], ["20260908", 1, ""], ["20260909", 1, ""]]);
    if (api_name === "daily") {
      assert.equal(params.trade_date, "20260907");
      return response([...fields, "pre_close", "pct_chg", "amount"], codes.map(code => [code, "20260907", 10, 11, 9, 10, 10, 0, 1000000]));
    }
    if (api_name === "daily_basic") return response(["ts_code", "trade_date", "turnover_rate", "volume_ratio", "pe_ttm", "pb", "total_mv"], codes.map(code => [code, "20260907", 1, 1, 20, 2, 100000]));
    if (api_name === "stock_basic") return response(["ts_code", "name", "industry", "list_date"], codes.map(code => [code, "fixture", "银行", "20200101"]));
    return response([], []);
  };
  const result = await generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "fixture" }, Date.parse("2026-09-07T23:35:00Z"), fetcher);
  assert.equal(result.meta.marketDataDate, "2026-09-07");
  assert.equal(result.meta.marketProvider, "Tushare主源");
  assert.equal(result.meta.selectedCount, 50);
});
