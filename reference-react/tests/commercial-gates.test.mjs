import test from "node:test";
import assert from "node:assert/strict";
import { collectNewsJob, refreshMarketClose, marketPulseJob, marketSnapshotState, reserveAiCall, handleApi, generateTop50Job, scheduledJobPlan, fetchUsEtfMapping, openingAuctionJob, runScheduled, buildPostCloseReview, postCloseReviewJob, readSourceQuality, metricFromAccuracyAggregate, tushareQuery, buildPredictionRecord, compactResearchRanking, classifyAiError } from "../worker/index.js";
import { assessTradingDay } from "../scripts/trading-day-acceptance.mjs";

function kv(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  return { values, get: async (key) => values.get(key) || null, put: async (key, value) => values.set(key, value),
    delete: async (key) => values.delete(key), list: async ({ prefix }) => ({ keys: [...values.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}
const table = (rows) => new Response(JSON.stringify({ code: 0, data: { fields: Object.keys(rows[0] || {}), items: rows.map(Object.values) } }));

test("ETF null and zero closes do not become a minus-100-percent signal", async () => {
  const result = await fetchUsEtfMapping(async () => new Response(JSON.stringify({ chart: { result: [{
    timestamp: [1787751000, 1787837400, 1787923800, 1788010200],
    indicators: { quote: [{ close: [100, 102, null, 0] }] },
  }] } })), Date.parse("2026-08-31T00:00:00Z"), { retryDelays: [] });
  assert.equal(result.items.length, 12);
  assert.ok(result.items.every((item) => item.close === 102 && item.pctChange === 2));
});

test("authenticated frozen sync preserves timestamps and retries without duplicates", async () => {
  const snapshotId = "TOP50-20260828-sync";
  const STOCK_STATE = kv({ "top50:latest": { meta: { snapshotId, tradeDate: "2026-08-28" } } });
  const env = { STOCK_STATE, ADMIN_API_TOKEN: "test" };
  const url = new URL("https://site.test/api/admin/bootstrap-snapshots");
  const forecast = { predictionId: `${snapshotId}:超短:000001.SZ:1d`, snapshotId, tradeDate: "2026-08-28", generatedAt: "2026-08-27T23:35:00.000Z", maturityTradeDate: "2026-08-31", referencePrice: 10, status: "pending" };
  const send = (item) => handleApi(new Request(url, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify({ predictions: [item] }) }), env, url);
  assert.equal((await send(forecast)).status, 200);
  assert.equal((await send(forecast)).status, 200);
  assert.equal(JSON.parse(STOCK_STATE.values.get("prediction-pipeline:latest")).frozenCount, 1);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get(`prediction:${forecast.predictionId}`)), forecast);
  assert.equal((await send({ ...forecast, generatedAt: "2026-08-28T02:00:00.000Z" })).status, 400);
});

test("publishes a synced TOP50 snapshot only after all frozen predictions arrive", async () => {
  const snapshotId = "TOP50-20260901-atomic";
  const previous = { meta: { snapshotId: "TOP50-20260831-old", tradeDate: "2026-08-31" }, cycles: {} };
  const top50 = { meta: { snapshotId, tradeDate: "2026-09-01", expectedPredictionCount: 2 }, cycles: { 短线: { ranking: [] } } };
  const STOCK_STATE = kv({ "top50:latest": previous });
  const env = { STOCK_STATE, ADMIN_API_TOKEN: "test" };
  const url = new URL("https://site.test/api/admin/bootstrap-snapshots");
  const send = (body) => handleApi(new Request(url, { method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json" }, body: JSON.stringify(body) }), env, url);
  const forecast = (code) => ({ predictionId: `${snapshotId}:超短:${code}:1d`, snapshotId, tradeDate: "2026-09-01", generatedAt: "2026-08-31T23:35:00.000Z", maturityTradeDate: "2026-09-02", referencePrice: 10, status: "pending" });

  assert.equal((await send({ top50 })).status, 200);
  assert.equal(JSON.parse(STOCK_STATE.values.get("top50:latest")).meta.snapshotId, previous.meta.snapshotId);
  assert.equal((await send({ predictions: [forecast("000001.SZ")] })).status, 200);
  assert.equal(JSON.parse(STOCK_STATE.values.get("top50:latest")).meta.snapshotId, previous.meta.snapshotId);
  assert.equal((await send({ predictions: [forecast("600036.SH")] })).status, 200);
  assert.equal(JSON.parse(STOCK_STATE.values.get("top50:latest")).meta.snapshotId, snapshotId);
  assert.equal(STOCK_STATE.values.has(`top50:pending-sync:${snapshotId}`), false);
});

test("Qinghong 403 switches to paid major_news with original URL and timestamp", async () => {
  const STOCK_STATE = kv();
  const result = await collectNewsJob({ STOCK_STATE, QINGHONG_API_KEY: "test", TUSHARE_PRIMARY_TOKEN: "test" }, async (_url, options) => {
    if (options.headers?.["X-API-Key"]) return new Response("denied", { status: 403 });
    assert.equal(JSON.parse(options.body).api_name, "major_news");
    return table([{ title: "央行降准支持银行信贷与资本市场", pub_time: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "), src: "新浪财经", url: "https://finance.sina.com.cn/finance/test.shtml" }]);
  });
  assert.equal(result.meta.fallbackActive, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].url, "https://finance.sina.com.cn/finance/test.shtml");
  assert.equal(result.meta.providerHealth[0].status, "unavailable");
});

test("weekend closes use verified Friday and ProMax fallback without realtime claims", async () => {
  const STOCK_STATE = kv({ "top50:latest": { cycles: { 波段: { ranking: [{ code: "000001" }] } } } });
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_URL: "https://fallback.test/pro", TUSHARE_FALLBACK_API_KEY: "test" };
  const result = await refreshMarketClose(env, Date.parse("2026-08-30T03:00:00Z"), async (url, options) => {
    if (options.method === "POST") {
      if (JSON.parse(options.body).api_name === "trade_cal") return table([
        { cal_date: "20260828", is_open: 1, pretrade_date: "20260827" },
        { cal_date: "20260830", is_open: 0, pretrade_date: "20260828" },
      ]);
      return new Response("down", { status: 503 });
    }
    assert.match(String(url), /daily\?trade_date=20260828/);
    return table([{ ts_code: "000001.SZ", trade_date: "20260828", close: 11, open: 10, high: 12, low: 10, pre_close: 10, pct_chg: 10, vol: 100, amount: 110 }]);
  });
  assert.equal(result.tradeDate, "2026-08-28");
  const market = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(market.quotes[0].volume, 10000);
  assert.equal(market.quotes[0].observedAt, "2026-08-28 15:00:00");
  assert.equal(marketSnapshotState(market, { session: "closed" }).status, "ready");
  assert.equal(marketSnapshotState(market, { session: "morning" }).status, "degraded");
});

test("TOP50 alone supplies market codes when cloud has no subscriptions", async () => {
  const STOCK_STATE = kv({ "top50:latest": { cycles: { 波段: { ranking: [{ code: "000001" }] } } } });
  const result = await marketPulseJob({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test" }, Date.parse("2026-08-31T02:00:00Z"), async (_url, options) => {
    assert.equal(JSON.parse(options.body).params.ts_code, "000001.SZ");
    return table([{ ts_code: "000001.SZ", trade_time: "2026-08-31 10:00:00", close: 11, open: 10, high: 12, low: 10, vol: 100, amount: 110000 }]);
  });
  assert.equal(result.quoteCount, 1);
});

test("fresh fetch timestamp cannot relabel old quotes live", () => {
  const health = marketSnapshotState({ meta: { provider: "ProMax rt_k", generatedAt: "2026-08-31T02:00:00Z" }, quotes: [{ observedAt: "2026-08-28 15:00:00" }] }, { session: "morning" }, null, Date.parse("2026-08-31T02:00:00Z"));
  assert.equal(health.status, "degraded");
});

test("empty primary intraday response switches to ProMax", async () => {
  const STOCK_STATE = kv({ "top50:latest": { cycles: { 波段: { ranking: [{ code: "000001" }] } } } });
  let fallbackCalls = 0;
  const result = await marketPulseJob({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_URL: "https://fallback.test", TUSHARE_FALLBACK_API_KEY: "test" }, Date.parse("2026-08-31T02:00:00Z"), async (_url, options) => {
    if (options.method === "POST") return table([]);
    fallbackCalls += 1;
    return table([{ ts_code: "000001.SZ", trade_time: "2026-08-31 10:00:00", close: 11, open: 10, vol: 100, amount: 110000 }]);
  });
  assert.equal(result.quoteCount, 1);
  assert.equal(fallbackCalls, 1);
});

test("invalid quotation timestamps cannot be labeled live", () => {
  const health = marketSnapshotState({ meta: { provider: "ProMax rt_k", generatedAt: "invalid" }, quotes: [] }, { session: "morning" });
  assert.equal(health.status, "degraded");
  assert.match(health.label, /无法核验/);
});

test("cached 29-sample metrics are withheld after gate upgrade", async () => {
  const STOCK_STATE = kv({ "accuracy:latest": { overall: { sampleCount: 29, sampleStatus: "sufficient", hitRate: 100 }, industries: {}, marketRegimes: {}, recentEvaluations: [] } });
  const url = new URL("https://site.test/api/accuracy");
  const body = await (await handleApi(new Request(url), { STOCK_STATE }, url)).json();
  assert.equal(body.overall.sampleCount, 29);
  assert.equal(body.overall.hitRate, null);
  assert.equal(body.minimumSample, 30);
});

test("concurrent AI reservations stop exactly at the daily cap", async () => {
  const env = { STOCK_STATE: kv(), AI_DAILY_CALL_LIMIT: "3" };
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveAiCall(env)));
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 3);
  assert.equal(results.filter((item) => item.status === "rejected").length, 17);
});

test("post-open generation cannot manufacture a premarket prediction", async () => {
  await assert.rejects(generateTop50Job({ STOCK_STATE: kv() }, Date.parse("2026-08-31T02:00:00Z")), /冻结窗口已结束/);
  assert.deepEqual(scheduledJobPlan(Date.parse("2026-08-31T09:40:00Z"), true).jobs, ["market-close", "post-close", "accuracy", "global-news"]);
});

test("repeating premarket generation reuses the completed frozen snapshot", async () => {
  const snapshot = { meta: { snapshotId: "frozen" }, cycles: {} };
  const STOCK_STATE = kv({ "prediction-pipeline:latest": { tradeDate: "2026-08-31", frozenCount: 50, snapshotId: "frozen" }, "top50:snapshot:frozen": snapshot });
  const result = await generateTop50Job({ STOCK_STATE }, Date.parse("2026-08-31T00:00:00Z"), () => { throw new Error("Must not regenerate frozen predictions"); });
  assert.deepEqual(result, snapshot);
});

test("trading-day acceptance rejects gaps and task failures instead of backfilling", () => {
  const date = "2026-08-31";
  const jobs = ["top50", "opening-auction", "market-pulse", "accuracy", "post-close", "market-close"].map((name) => ({ name, status: "completed" }));
  const rows = Array.from({ length: 676 }, (_, i) => {
    const at = new Date(Date.parse(`${date}T07:30:00+08:00`) + i * 60000).toISOString();
    const minute = 450 + i;
    return { at, date, time: `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`, tradingDay: true, jobs, errors: [], budgetUsed: 1, budgetLimit: 200, pipeline: { tradeDate: date, frozenCount: 50 } };
  });
  assert.equal(assessTradingDay(rows, date).status, "passed");
  assert.equal(assessTradingDay(rows.filter((row) => row.time < "10:00" || row.time > "10:10"), date).status, "failed");
  assert.equal(assessTradingDay(rows.slice(0, 200), date).status, "in_progress");
  rows[150].errors.push("Market stale");
  assert.equal(assessTradingDay(rows.slice(0, 200), date).status, "failed");
  assert.equal(assessTradingDay(rows, date).status, "failed");
});

test("auction rejects old or invalid primary rows and uses ProMax", async () => {
  for (const primary of [[], [{ ts_code: "000001.SZ", trade_date: "20260828", price: 10 }], [{ ts_code: "000001.SZ", trade_date: "20260831", price: 0 }]]) {
    let fallbackCalls = 0;
    const result = await openingAuctionJob({ STOCK_STATE: kv(), TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_URL: "https://fallback.test", TUSHARE_FALLBACK_API_KEY: "test" }, Date.parse("2026-08-31T01:25:00Z"), async (_url, options) => {
      if (options.method === "POST") return table(primary);
      fallbackCalls += 1;
      return table([{ ts_code: "000001.SZ", trade_date: "20260831", price: 11, pre_close: 10 }]);
    });
    assert.equal(fallbackCalls, 1);
    assert.equal(result.meta.provider, "ProMax stk_auction");
    assert.equal(result.quotes[0].price, 11);
  }
});

test("scheduler does not count pending auction data as completed", async () => {
  const STOCK_STATE = kv({ "trade-calendar:2026-08-31": { isOpen: true }, "news:latest": { meta: { generatedAt: "2026-08-31T01:25:00Z" } } });
  const result = await runScheduled({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test" }, Date.parse("2026-08-31T01:26:00Z"), async () => table([]));
  assert.equal(result.results.find((job) => job.name === "opening-auction").status, "pending");
  assert.equal(JSON.parse(STOCK_STATE.values.get("job:2026-08-31:09:26:opening-auction")).status, "pending");
  const repeated = await runScheduled({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test" }, Date.parse("2026-08-31T01:30:00Z"), async () => { throw new Error("Duplicate auction call"); });
  assert.ok(!repeated.results.some((job) => job.name === "opening-auction"));
});

test("acceptance identifies orphaned tasks without rewriting their original record", async () => {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const key = `job:${date}:09:30:market-pulse`;
  const state = { startedAt: new Date(Date.now() - 16 * 60000).toISOString() };
  const STOCK_STATE = kv({ [key]: state, [`job:${date}:09:31:intraday-news`]: { startedAt: new Date().toISOString() } });
  const url = new URL("https://site.test/api/acceptance");
  const result = await (await handleApi(new Request(url), { STOCK_STATE }, url)).json();
  assert.equal(result.jobs.find((job) => job.name === "market-pulse").status, "interrupted");
  assert.equal(result.jobs.find((job) => job.name === "intraday-news").status, "running");
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get(key)), state);
});

test("known task interruptions fail acceptance before the day ends", () => {
  const row = { date: "2026-08-31", at: "2026-08-30T23:30:00Z", time: "07:30", tradingDay: true, errors: [], budgetUsed: 0, budgetLimit: 200, jobs: [{ name: "market-pulse", status: "interrupted" }] };
  assert.equal(assessTradingDay([row], row.date).status, "failed");
});

test("acceptance retains failed calendar endpoint observations on a verified trading day", () => {
  const row = { date: "2026-08-31", at: "2026-08-30T23:30:00Z", time: "07:30", tradingDay: true, errors: [], budgetUsed: 0, budgetLimit: 200 };
  const missing = { ...row, at: "2026-08-30T23:31:00Z", time: "07:31", tradingDay: null, errors: ["acceptance: fetch failed"] };
  assert.equal(assessTradingDay([row, missing], row.date).status, "failed");
});

test("critical single-run jobs tolerate a delayed tick but never cross the five-minute window", () => {
  assert.ok(scheduledJobPlan(Date.parse("2026-08-31T09:42:00Z"), true).jobs.includes("accuracy"));
  assert.ok(!scheduledJobPlan(Date.parse("2026-08-31T09:45:00Z"), true).jobs.includes("accuracy"));
  assert.ok(scheduledJobPlan(Date.parse("2026-08-30T23:22:00Z"), true).jobs.includes("us-etf-map"));
});

test("ProMax uses one bounded batch request without fan-out", async () => {
  const ranking = Array.from({ length: 40 }, (_, i) => ({ code: String(i + 1).padStart(6, "0") }));
  const env = { STOCK_STATE: kv({ "top50:latest": { cycles: { 波段: { ranking } } } }), TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_URL: "https://fallback.test", TUSHARE_FALLBACK_API_KEY: "test" };
  let active = 0, peak = 0;
  const result = await marketPulseJob(env, Date.parse("2026-08-31T02:00:00Z"), async (url, options) => {
    if (options.method === "POST" || String(url).includes("/rt_min")) return table([]);
    active += 1; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return table(new URL(url).searchParams.get("ts_code").split(",").map((ts_code) => ({ ts_code, close: 11, trade_time: "2026-08-31 10:00:00" })));
  });
  assert.equal(peak, 1);
  assert.equal(result.quoteCount, 40);
});

test("fallback deadline retains partial data instead of unbounded split retries", async (t) => {
  let clock = Date.parse("2026-08-31T02:00:00Z");
  t.mock.method(Date, "now", () => clock);
  const ranking = Array.from({ length: 30 }, (_, i) => ({ code: String(i + 1).padStart(6, "0") }));
  const STOCK_STATE = kv({ "top50:latest": { cycles: { 波段: { ranking } } } });
  let dailyCalls = 0;
  await marketPulseJob({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_URL: "https://fallback.test", TUSHARE_FALLBACK_API_KEY: "test" }, clock, async (url, options) => {
    if (options.method === "POST" || String(url).includes("/rt_min")) return table([]);
    dailyCalls += 1;
    clock += 61000;
    return table([{ ts_code: "000001.SZ", close: 11, trade_time: "2026-08-31 10:00:00" }]);
  });
  assert.equal(dailyCalls, 1);
  const snapshot = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(snapshot.meta.status, "partial");
  assert.equal(snapshot.meta.failedCount, 29);
});

const reviewFixture = () => ({ meta: { tradeDate: "2026-08-31", snapshotId: "frozen-test", generatedAt: "2026-08-30T23:35:00Z", marketDataDate: "2026-08-28" },
  cycles: Object.fromEntries(["超短", "短线", "波段", "中长线"].map((cycle) => [cycle, { ranking: [{ code: "000001", tsCode: "000001.SZ", name: "平安银行", industry: "银行", close: 10, invalidPrice: 9, rank: 1 }] }])) });

test("review uses only matching current-day closes and does not claim prediction accuracy", () => {
  const report = buildPostCloseReview(reviewFixture(), [{ ts_code: "000001.SZ", trade_date: "20260831", close: 8 }], null, "2026-08-31");
  assert.equal(report.status, "ready");
  assert.equal(report.cycles[0].averageChange, -20);
  assert.equal(report.cycles[0].invalidated, 1);
  assert.match(report.method, /不是到期预测命中率/);
  const stale = buildPostCloseReview(reviewFixture(), [{ ts_code: "000001.SZ", trade_date: "20260828", close: 12 }], null, "2026-08-31");
  assert.equal(stale.status, "partial");
  assert.equal(stale.cycles[0].stocks[0].close, null);
  assert.equal(stale.cycles[0].averageChange, null);
});

test("review rejects future and old news and preserves source links", () => {
  const news = { items: ["2026-08-30T03:00:00Z", "2026-08-31T03:00:00Z", "2026-09-01T03:00:00Z"].map((publishedAt) => ({ title: "市场事件", publishedAt, url: "https://news.example/article" })) };
  const report = buildPostCloseReview(reviewFixture(), [], news, "2026-08-31", Date.parse("2026-08-31T08:00:00Z"));
  assert.equal(report.news.length, 1);
  assert.equal(report.news[0].publishedAt, "2026-08-31T03:00:00Z");
});

test("review source failover and partial attempts preserve the previous complete report", async () => {
  const previous = { status: "ready", id: "original", tradeDate: "2026-08-31" };
  const STOCK_STATE = kv({ "top50:latest": reviewFixture(), "trade-calendar:2026-08-31": { isOpen: true }, "review:day:2026-08-31": previous });
  let calls = 0;
  const result = await postCloseReviewJob({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "test", TUSHARE_FALLBACK_API_KEY: "test", TUSHARE_FALLBACK_URL: "https://fallback.test" }, Date.parse("2026-08-31T08:00:00Z"), async (_url, options) => {
    calls += 1;
    return table(options.method === "POST" ? [] : [{ ts_code: "000002.SZ", trade_date: "20260831", close: 8 }]);
  });
  assert.equal(calls, 2);
  assert.equal(result.status, "pending");
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("review:day:2026-08-31")), previous);
});

test("review generation is not exposed through anonymous mutation and pre-close stays pending", async () => {
  const url = new URL("https://site.test/api/admin/review");
  assert.equal((await handleApi(new Request(url, { method: "POST", body: "{}" }), { STOCK_STATE: kv() }, url)).status, 401);
  assert.equal((await postCloseReviewJob({ STOCK_STATE: kv() }, Date.parse("2026-08-31T01:00:00Z"))).status, "pending");
  assert.ok(scheduledJobPlan(Date.parse("2026-08-31T09:42:00Z"), true).jobs.includes("post-close"));
});

test("source-quality reports observed failures without exposing provider secrets or errors", async () => {
  const STOCK_STATE = kv();
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "private-value", TUSHARE_FALLBACK_API_KEY: "other-private", TUSHARE_FALLBACK_URL: "https://fallback.test" };
  await tushareQuery(env, "daily", {}, "", async (_url, options) => options.method === "POST" ? new Response("private-value", { status: 503 }) : table([{ close: 10, trade_date: "20260831" }]));
  const report = await readSourceQuality(env);
  assert.equal(report.sampleCount, 2);
  assert.equal(report.endpoints.find((item) => item.provider === "Tushare主源").failureRate, 100);
  assert.equal(report.endpoints.find((item) => item.provider === "ProMax").quotaRemaining, null);
  assert.ok(!JSON.stringify(report).includes("private"));
});

test("benchmark gate uses paired count, not total prediction count", () => {
  const base = { count: 100, hits: 60, brierSum: 20, returnSum: 3, minMAE: -0.1, pairedCount: 29, benchmarkSum: 0.29, excessSum: 0.58 };
  assert.equal(metricFromAccuracyAggregate(base).averageExcessReturn, null);
  const result = metricFromAccuracyAggregate({ ...base, pairedCount: 30, benchmarkSum: 0.3, excessSum: 0.6 });
  assert.equal(result.benchmarkAverageReturn, 0.01);
  assert.equal(result.averageExcessReturn, 0.02);
  assert.equal(metricFromAccuracyAggregate({ ...base, count: 29 }).hitRate, null);
});

test("new prediction records freeze benchmark while legacy records remain unmodified", () => {
  const args = { snapshotId: "frozen", cycle: "短线", item: { tsCode: "000001.SZ", probabilityUp: 0.6 }, horizon: { id: "1d" } };
  const legacy = buildPredictionRecord(args);
  assert.equal(legacy.benchmark, null);
  const benchmark = { code: "000001.SH", referencePrice: 3000, referenceDate: "2026-08-28" };
  assert.deepEqual(buildPredictionRecord({ ...args, benchmark }).benchmark, benchmark);
  assert.equal(legacy.benchmark, null);
});

test("AI context excludes repeated full evidence and preserves prediction links", () => {
  const ranking = Array.from({ length: 50 }, (_, i) => ({ code: String(i), name: "股票", predictionId: `id-${i}`, selectionEvidence: { repeated: "long evidence ".repeat(1000) } }));
  const compact = compactResearchRanking(ranking);
  assert.equal(compact.length, 20);
  assert.equal(compact[0].predictionId, "id-0");
  assert.ok(JSON.stringify(compact).length < 6000);
  assert.equal(classifyAiError(new Error("AI input exceeds budget limit")).retryable, false);
});
