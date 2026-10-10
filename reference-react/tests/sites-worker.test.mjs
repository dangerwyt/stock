import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { readAiJobConnection } from "../src/ai-job-connection.js";
import * as workerModule from "../worker/index.js";
import worker, {
  applyDailyCatchUp,
  buildResearchSources,
  buildIndustrySnapshot,
  buildOperationsSnapshot,
  buildRiskSnapshot,
  buildUserFacingProviderAlerts,
  buildStructuredResearchSources,
  buildTop50Snapshot,
  appendPredictionEvent,
  calculateAccuracy,
  compactNotifications,
  classifyAiError,
  evaluatePredictionsJob,
  fetchQinghongFinance,
  fetchUsEtfMapping,
  filterUniqueNewsArticles,
  generateTop50Job,
  getUsEtfMapSnapshot,
  handleApi,
  inferNewsEntities,
  marketPulseJob,
  marketSnapshotState,
  migrateLegacyPrediction,
  normalizeNews,
  normalizeIntradayRow,
  normalizeMarketSnapshot,
  scoreNewsArticle,
  openingAuctionJob,
  requestAI,
  recordOpsEvent,
  runAgentWithRetry,
  runTeacherQueue,
  resolveTeacherProfiles,
  sanitizeNewsSnapshot,
  sanitizeTop50Snapshot,
  selectMarketSnapshot,
  screenTradableUniverse,
  scheduledJobPlan,
  sendNotification,
  tushareQuery,
  transitionComponentState,
  updateAiQueueSummary,
} from "../worker/index.js";
import { focusWithAnimationFrame } from "../src/focus-utils.js";
import { newsCategories, newsCategoryMatches, newsTierLabel } from "../src/news-taxonomy.js";
import {
  deriveAgentProgress,
  deriveSummaryState,
  shouldKeepAgentJob,
  shouldShowAgentRunStatus,
} from "../src/ai-job-state.js";
import { isCurrentEvidenceRequest } from "../src/evidence-request.js";

function createMemoryKv() {
  const values = new Map();
  const metadata = new Map();
  const puts = [];
  return {
    get: async (key) => values.get(key) || null,
    put: async (key, value, options) => {
      values.set(key, value);
      metadata.set(key, options?.metadata);
      puts.push({ key, value, options: options || null });
    },
    delete: async (key) => {
      values.delete(key);
      metadata.delete(key);
    },
    list: async ({ prefix = "" } = {}) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name, metadata: metadata.get(name) })),
    }),
    values,
    metadata,
    puts,
  };
}

function createCountedMemoryKv() {
  const values = new Map();
  const metadata = new Map();
  const operations = { get: 0, put: 0, list: 0, total: 0, listPrefixes: [] };
  const count = (type) => {
    operations[type] += 1;
    operations.total += 1;
  };
  return {
    get: async (key) => { count("get"); return values.get(key) || null; },
    put: async (key, value, options) => { count("put"); values.set(key, value); metadata.set(key, options?.metadata); },
    delete: async (key) => { values.delete(key); metadata.delete(key); },
    list: async ({ prefix = "" } = {}) => {
      count("list");
      operations.listPrefixes.push(prefix);
      return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name, metadata: metadata.get(name) })), list_complete: true };
    },
    values,
    metadata,
    operations,
  };
}

function createPagedMemoryKv(pages) {
  const values = new Map();
  const listCalls = [];
  return {
    get: async (key) => values.get(key) || null,
    put: async (key, value) => values.set(key, value),
    list: async ({ cursor } = {}) => {
      listCalls.push(cursor || null);
      const page = pages[cursor || "first"] || { keys: [] };
      return { keys: page.keys || [], cursor: page.cursor, list_complete: !page.cursor };
    },
    values,
    listCalls,
  };
}

function createMemoryD1() {
  const values = new Map();
  const statements = [];
  return {
    values,
    statements,
    DB: {
      prepare(sql) {
        const run = async (params = []) => {
          statements.push({ sql, params });
          if (sql.includes("CREATE TABLE")) return { success: true };
          if (sql.includes("ON CONFLICT(key) DO NOTHING")) {
            if (values.has(params[0])) return { success: true, meta: { changes: 0 } };
            values.set(params[0], params[1]);
            return { success: true, meta: { changes: 1 } };
          }
          throw new Error(`unexpected D1 run: ${sql}`);
        };
        return {
          run: () => run(),
          bind(...params) {
            return {
              run: () => run(params),
            };
          },
        };
      },
    },
  };
}

function sampleRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    ts_code: `${String(600000 + index).padStart(6, "0")}.SH`,
    trade_date: "20260826",
    name: `测试股票${index + 1}`,
    open: 10 + index,
    high: 10.8 + index,
    low: 9.7 + index,
    close: 10.5 + index,
    pct_chg: (index % 12) - 3,
    amount: 100000 + index * 10000,
    turnover_rate: 0.8 + index * 0.09,
    volume_ratio: 0.7 + index * 0.03,
    pe_ttm: 12 + index,
    pb: 1.1 + index * 0.04,
    total_mv: 1000000 + index * 50000,
  }));
}

function top50GenerationFixture() {
  const STOCK_STATE = createMemoryKv();
  const teacherNames = ["陈江挺", "养家", "谭琦", "曹名长", "产业调研凌", "曹靖楠", "产业调研福总", "菠萝", "曾剑枫", "寻龙一手", "龙一", "短线委员会"];
  teacherNames.forEach((name, index) => STOCK_STATE.values.set(`teacher-versions:${name}`, JSON.stringify([
    { id: `knowledge-${index + 1}`, type: "knowledge", status: "production" },
  ])));
  const rows = sampleRows(60);
  const futureCalendarDates = Array.from({ length: 65 }, (_, index) => {
    const value = new Date(Date.UTC(2026, 7, 28 + index));
    return value.toISOString().slice(0, 10).replaceAll("-", "");
  });
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    const response = (fields, items) => new Response(JSON.stringify({ code: 0, data: { fields, items } }), { status: 200 });
    if (request.api_name === "trade_cal") {
      const dates = ["20260826", "20260827", ...futureCalendarDates];
      return response(["exchange", "cal_date", "is_open", "pretrade_date"], dates.map((date, index) => ["SSE", date, 1, dates[Math.max(0, index - 1)]]));
    }
    if (request.api_name === "index_daily" && request.params.ts_code === "000001.SH") {
      const indexRows = Array.from({ length: 21 }, (_, index) => ["000001.SH", `202608${String(index + 1).padStart(2, "0")}`, 3000 + index * 5]);
      return response(["ts_code", "trade_date", "close"], indexRows);
    }
    if (request.api_name === "daily") return response(
      ["ts_code", "trade_date", "open", "high", "low", "close", "pre_close", "pct_chg", "vol", "amount"],
      rows.map((item) => [item.ts_code, item.trade_date, item.open, item.high, item.low, item.close, item.close - 0.1, item.pct_chg, 1000, item.amount]),
    );
    if (request.api_name === "daily_basic") return response(
      ["ts_code", "trade_date", "turnover_rate", "volume_ratio", "pe_ttm", "pb", "total_mv", "circ_mv"],
      rows.map((item) => [item.ts_code, item.trade_date, item.turnover_rate, item.volume_ratio, item.pe_ttm, item.pb, item.total_mv, item.total_mv]),
    );
    if (request.api_name === "stock_basic") return response(
      ["ts_code", "name", "industry", "list_date"],
      rows.map((item) => [item.ts_code, item.name, "电子", "20200101"]),
    );
    throw new Error(`unexpected Tushare request: ${request.api_name}`);
  };
  return { STOCK_STATE, fetchImpl };
}

function makeCninfoDisclosure(overrides = {}) {
  return {
    title: "宁德时代公告拟回购股份用于员工持股计划",
    description: "公司披露回购金额上限并说明资金来源。",
    publishedAt: "2026-08-27T09:20:00.000Z",
    sourceId: "cninfo-latest",
    source: { name: "巨潮资讯" },
    url: "https://example.test/cninfo-disclosure",
    ...overrides,
  };
}

test("serves existing static assets without a fallback", async () => {
  const calls = [];
  const response = await worker.fetch(new Request("https://example.test/assets/app.js"), {
    ASSETS: {
      fetch: async (request) => {
        calls.push(new URL(request.url).pathname);
        return new Response("asset", { status: 200 });
      },
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/assets/app.js"]);
});

test("serves shared data snapshots with edge cache headers", async () => {
  const response = await worker.fetch(new Request("https://example.test/data/top50-snapshot.json"), {
    ASSETS: {
      fetch: async () => new Response('{"status":"ready"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "public, max-age=60, stale-while-revalidate=300");
  assert.equal(response.headers.get("x-data-cache"), "shared-edge");
});

test("TOP50 snapshot contains four independent factor-profile cycle rankings", async () => {
  const source = await readFile(new URL("../public/data/top50-snapshot.json", import.meta.url), "utf8");
  const snapshot = JSON.parse(source);
  const cycles = ["超短", "短线", "波段", "中长线"];

  assert.deepEqual(Object.keys(snapshot.cycles), cycles);
  assert.equal(snapshot.meta.selectionEngine, "12套可审计因子画像周期加权");
  assert.equal(snapshot.meta.aiRole, "证据汇总与风险复核");

  for (const cycle of cycles) {
    const item = snapshot.cycles[cycle];
    assert.match(item.snapshotId, /^TOP50-20260730-/);
    assert.ok(item.weights.length >= 4);
    assert.equal(item.ranking.length, 12);
    assert.equal(new Set(item.ranking.map((stock) => stock.code)).size, 12);
  }

  assert.notEqual(snapshot.cycles["超短"].ranking[0].code, snapshot.cycles["中长线"].ranking[0].code);
});

test("keeps the 124 benchmark parity loops in the product source", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  for (const tool of ["market", "analysis", "backtest", "signals", "screener", "predict", "evaluate", "simulation"]) {
    assert.match(source, new RegExp(`id: "${tool}"`));
  }

  assert.match(source, /单股监控/);
  assert.match(source, /方向因子/);
  assert.doesNotMatch(source, /上涨概率|方向概率|聚焦高胜率/);
  assert.match(source, /预测准确率/);
  assert.match(source, /历史命中率/);
  assert.match(source, /function DecisionSummary/);
  assert.match(source, /function MonitorCommandBar/);
  assert.match(source, /function WatchlistMonitorPanel/);
  assert.match(source, /股票监控控制台/);
  assert.match(source, /与侧边栏、自选组合同步/);
  assert.match(source, /function FocusedPhaseWorkbench/);
  assert.match(source, /function TopOpportunityQueue/);
  assert.match(source, /function IntelligencePanel/);
  assert.match(source, /function SingleStockDecisionCard/);
  assert.match(source, /function StockDecisionModal/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /加入自选股/);
  assert.match(source, /stockModalStock/);
  assert.match(source, /function MarketResearchBrief/);
  assert.match(source, /function StockResearchWorkbench/);
  assert.match(source, /stock-watchlist/);
  assert.match(source, /function MarketCenterPage/);
  assert.match(source, /定时行情中心/);
  assert.match(source, /function StockSearchDialog/);
  assert.match(source, /\/api\/stocks\/search/);
  assert.match(source, /stock-watchlist-details/);
  assert.match(source, /搜索股票并加入自选/);
  assert.match(source, /30日均价/);
  assert.match(source, /60日均价/);
  assert.match(source, /今日分时均价/);
  assert.match(source, /ETF映射方向筛选/);
  assert.match(source, /个股资讯/);
  assert.match(source, /newsCategoryMatches\(item, category\)/);
  assert.match(source, /newsTierLabel\(item\)/);
  assert.match(source, /home-breaking-ticker/);
  assert.match(source, /四周期TOP50/);
  assert.match(source, /超短/);
  assert.match(source, /短线/);
  assert.match(source, /中长线/);
  assert.match(source, /总体准确率/);
  assert.match(source, /看涨准确率/);
  assert.match(source, /看跌准确率/);
  assert.match(source, /terminal-market-summary/);
  assert.match(styles, /font-family: -apple-system, BlinkMacSystemFont/);
  assert.match(styles, /--bg: #0f1117/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1\.13fr\) minmax\(390px, \.87fr\)/);
  assert.match(styles, /\.heatmap-grid \{\s*grid-template-columns: repeat\(2/);
  assert.match(source, /function resolveWatchlistStocks/);
  assert.match(source, /与侧边栏实时一致/);
  assert.doesNotMatch(source, /useState\(portfolio\)/);
  assert.match(source, /上一只股票/);
  assert.match(source, /下一只股票/);
  assert.match(source, /行情日期/);
  assert.match(source, /价格提醒/);
  assert.match(source, /风险预警/);
  assert.match(source, /盘前复核/);
  assert.match(source, /stock-followup-actions/);
  assert.match(source, /可同步匿名设备提醒/);
  assert.match(source, /\/api\/ai\/jobs/);
  assert.match(source, /真实方向命中率/);
  assert.match(source, /newsCategoryMatches\(item, category\)/);
  assert.match(source, /newsTierLabel\(item\)/);
  assert.match(source, /NotificationCenter/);
  assert.doesNotMatch(source, /const monitorMetrics/);
  assert.doesNotMatch(source, /const toolTrendData/);
  assert.doesNotMatch(source, /const backtestData/);
  assert.match(source, /今日决策摘要/);
  assert.match(source, /12套因子画像/);
  assert.match(source, /模拟交易/);
  assert.match(source, /href=\{item\.url\} target="_blank"/);
  assert.match(source, /模拟买入 \$\{quantity\} 股成功/);
});

test("does not concatenate unavailable hit rates into null percentages", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /<b>\{item\.hitRate\}%<\/b>/);
  assert.doesNotMatch(source, /sampleCount \? `\$\{accuracy\.overall\.hitRate\}%`/);
  assert.match(source, /Number\.isFinite\(item\.hitRate\).*样本不足/);
  assert.match(source, /Number\.isFinite\(accuracy\?\.overall\?\.hitRate\).*accuracy\.overall\.hitRate/);
});

test("accuracy page exposes sample gates and prediction evidence dialog", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /sampleStatus === "insufficient"/);
  assert.match(source, /样本积累中（/);
  assert.match(source, /\/api\/accuracy\/evidence\?predictionId=/);
  assert.match(source, /查看证据/);
  assert.match(source, /role="dialog" aria-modal="true"/);
  assert.match(source, /Escape/);
});

test("guards evidence dialog updates by active prediction request", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /const evidenceRequestRef = useRef\(\{ token: 0, predictionId: null \}\)/);
  assert.match(source, /const request = \{ token: evidenceRequestRef\.current\.token \+ 1, predictionId: item\.id \}/);
  assert.match(source, /if \(!isCurrentEvidenceRequest\(evidenceRequestRef\.current, request\)\) return;/);
});

test("home previews five stocks and news exposes scoring evidence", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /ranking\.slice\(0, 5\)/);
  assert.match(source, /\/api\/top50\/evidence\?predictionId=/);
  assert.match(source, /selectionEvidence/);
  assert.match(source, /scoreBreakdown/);
  assert.match(source, /选股证据/);
  assert.match(source, /等待下一次 07:20 冻结榜单/);
});

test("news center uses mutually exclusive tier buckets and original source links", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /newsCategoryMatches\(item, category\)/);
  assert.match(source, /newsTierLabel\(item\)/);
  assert.match(source, /classificationReason/);
  assert.match(source, /scoreBreakdown/);
  assert.match(source, /<a[^>]+href=\{item\.url\}[^>]+target="_blank"[^>]+rel="noreferrer"/);
});

test("task3 keeps mobile layout and Top50 evidence dialog focus recovery", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const top50DialogStart = source.indexOf("function Top50EvidenceDialog(");
  const top50PageStart = source.indexOf("function Top50Page(");
  const newsPageStart = source.indexOf("function NewsPage(", top50PageStart);
  assert.ok(top50DialogStart !== -1 && top50PageStart !== -1 && newsPageStart !== -1);
  assert.ok(top50DialogStart < top50PageStart);

  const top50DialogSource = source.slice(top50DialogStart, top50PageStart);
  const top50PageSource = source.slice(top50PageStart, newsPageStart);

  assert.match(top50PageSource, /top50-page/);
  assert.match(top50PageSource, /const triggerRef = useRef\(null\);/);
  assert.match(top50PageSource, /if \(event\.key === "Escape"\) closeEvidence\(\);/);
  assert.match(top50PageSource, /focusWithAnimationFrame\(triggerRef\.current\);/);
  assert.match(top50PageSource, /role="tab"/);
  assert.match(top50PageSource, /table-action evidence-trigger/);
  assert.match(top50PageSource, /top50-mobile-list/);
  assert.match(top50PageSource, /等待下一次 07:20 冻结榜单/);
  assert.match(top50PageSource, /\/api\/top50\/evidence\?predictionId=/);
  assert.match(top50DialogSource, /role="dialog" aria-modal="true"/);
  assert.match(top50DialogSource, /选股证据/);
  assert.match(top50DialogSource, /selectionEvidence/);
  assert.match(top50DialogSource, /factorBreakdown/);
  assert.match(styles, /\.top50-mobile-list \{ display: none; \}/);
  assert.match(styles, /\.top50-page \.table-wrap \{ display: none; \}/);
  assert.match(styles, /grid-template-areas: "rank name score status"/);
  assert.match(styles, /overflow-x:\s*hidden/);
});

test("operations page is read-only, timestamped, and responsive", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.match(source, /function OperationsPage/);
  assert.match(source, /运行状态/);
  assert.match(source, /observedAt/);
  assert.match(source, /\/api\/operations/);
  assert.doesNotMatch(source, /显示原始错误/);
  assert.match(styles, /\.operations-grid/);
  assert.match(styles, /\.operations-card\.unknown/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.operations-grid/);
});

test("focus helper defers restoration onto the next animation frame", () => {
  let scheduled = 0;
  let focused = 0;
  const trigger = { focus: () => { focused += 1; } };

  focusWithAnimationFrame(trigger, (callback) => {
    scheduled += 1;
    callback();
    return 1;
  });

  assert.equal(scheduled, 1);
  assert.equal(focused, 1);
});

test("reports missing production providers without pretending live readiness", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/status"), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "configuration_required");
  assert.equal(body.mode, "demo");
  assert.equal(body.scheduleTimeZone, "Asia/Shanghai");
  assert.equal(body.providers.market.configured, false);
  assert.equal(body.providers.ai.configured, false);
  assert.equal(body.providers.quant.configured, false);
  assert.equal(body.providers.notification.configured, false);
});

test("accepts Qinghong as the configured live news provider", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/status"), {
    QINGHONG_API_KEY: "secret",
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(body.providers.news.configured, true);
  assert.deepEqual(body.providers.news.activeProviders, ["晴红50+"]);
});

test("does not claim live readiness before real TOP50 and news snapshots exist", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/status"), {
    TUSHARE_PRIMARY_TOKEN: "market-secret",
    QINGHONG_PRO_API_KEY: "news-secret",
    MINIMAX_API_KEY: "ai-secret",
    NOTIFICATION_WEBHOOK_URL: "https://notify.example.test",
    STOCK_STATE: createMemoryKv(),
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(body.status, "warming_up");
  assert.equal(body.mode, "demo");
  assert.equal(body.snapshots.top50, null);
  assert.equal(body.snapshots.news, null);
});

test("operations status requires an observation timestamp", () => {
  const snapshot = buildOperationsSnapshot({
    events: [],
    status: {},
    now: Date.parse("2026-08-27T10:00:00Z"),
  });

  assert.equal(snapshot.components.market.status, "unknown");
  assert.equal(snapshot.components.market.observedAt, null);
});

test("operations telemetry is TTL-bound and API responses stay sanitized", async () => {
  const STOCK_STATE = createMemoryKv();
  await recordOpsEvent({ STOCK_STATE }, {
    component: "market",
    outcome: "failure",
    errorCategory: "rate_limit",
    durationMs: 125,
    occurredAt: "2026-08-27T09:55:00.000Z",
    error: new Error("https://provider.example.test?token=secret stack trace"),
  });
  await recordOpsEvent({ STOCK_STATE }, {
    component: "market",
    outcome: "failure",
    errorCategory: "rate_limit",
    durationMs: 225,
    occurredAt: "2026-08-27T09:56:00.000Z",
  });

  const response = await handleApi(
    new Request("https://example.test/api/operations"),
    { STOCK_STATE },
    new URL("https://example.test/api/operations"),
  );
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(response.headers.get("cache-control"), "public, max-age=30, stale-while-revalidate=60");
  assert.equal(body.components.market.errorCategory, "rate_limit");
  assert.equal(body.components.market.consecutiveFailures, 2);
  assert.doesNotMatch(serialized, /https?:|token=|"token"|stack|secret/i);
  const indexed = STOCK_STATE.puts.filter((item) => item.key.startsWith("ops-recent:"));
  assert.equal(indexed.length, 2);
  assert.equal(indexed[0].options.expirationTtl, 90 * 86400);
  assert.equal(indexed[1].options.metadata.occurredAt, "2026-08-27T09:56:00.000Z");
  assert.equal(STOCK_STATE.values.has("ops-events:recent"), false);
});

test("concurrent immutable operations events remain visible in newest-first key order", async () => {
  const STOCK_STATE = createMemoryKv();
  await Promise.all([
    recordOpsEvent({ STOCK_STATE }, { eventId: "event-a", component: "news", outcome: "success", occurredAt: "2026-08-27T09:00:00.000Z" }),
    recordOpsEvent({ STOCK_STATE }, { eventId: "event-b", component: "news", outcome: "success", occurredAt: "2026-08-27T09:01:00.000Z" }),
  ]);

  const response = await handleApi(new Request("https://example.test/api/operations"), { STOCK_STATE }, new URL("https://example.test/api/operations"));
  const body = await response.json();
  assert.equal(body.components.news.lastSuccessAt, "2026-08-27T09:01:00.000Z");
  assert.equal([...STOCK_STATE.values.keys()].filter((key) => key.startsWith("ops-recent:")).length, 2);
});

test("operations API reads indexed event metadata in fewer than twenty KV operations", async () => {
  const STOCK_STATE = createCountedMemoryKv();
  const events = Array.from({ length: 500 }, (_, index) => ({
    eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    component: "market",
    outcome: "success",
    occurredAt: new Date(Date.parse("2026-08-27T09:00:00.000Z") + index * 1000).toISOString(),
  })).reverse();
  for (const event of events) {
    const timestamp = String(9_999_999_999_999 - Date.parse(event.occurredAt)).padStart(13, "0");
    STOCK_STATE.values.set(`ops-recent:${timestamp}:${event.eventId}`, JSON.stringify(event));
    STOCK_STATE.metadata.set(`ops-recent:${timestamp}:${event.eventId}`, event);
  }
  STOCK_STATE.operations.get = 0;
  STOCK_STATE.operations.put = 0;
  STOCK_STATE.operations.list = 0;
  STOCK_STATE.operations.total = 0;

  const response = await handleApi(
    new Request("https://example.test/api/operations"),
    { STOCK_STATE },
    new URL("https://example.test/api/operations"),
  );

  assert.equal(response.status, 200);
  assert.ok(STOCK_STATE.operations.total < 20, `expected <20 KV ops, received ${STOCK_STATE.operations.total}`);
  assert.deepEqual(STOCK_STATE.operations.listPrefixes.sort(), ["ai-active:", "ops-recent:"]);
});

test("legacy operations event keys provide a best-effort last success snapshot", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("ops-event:legacy-market", JSON.stringify({
    eventId: "legacy-market",
    component: "market",
    outcome: "success",
    occurredAt: "2026-08-27T09:00:00.000Z",
  }));

  const response = await handleApi(new Request("https://example.test/api/operations"), { STOCK_STATE }, new URL("https://example.test/api/operations"));
  const body = await response.json();

  assert.equal(body.components.market.lastSuccessAt, "2026-08-27T09:00:00.000Z");
  assert.equal(JSON.parse(STOCK_STATE.values.get("operations:migration-required")).legacyEventCount, 1);
});

test("AI active job keys track concurrent jobs and terminal retries without counters", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE };
  const now = new Date().toISOString();

  await Promise.all([
    updateAiQueueSummary(env, "job-a", null, "queued", now),
    updateAiQueueSummary(env, "job-b", null, "queued", now),
  ]);

  let response = await handleApi(new Request("https://example.test/api/operations"), env, new URL("https://example.test/api/operations"));
  assert.equal((await response.json()).components.ai.queueDepth, 2);

  await updateAiQueueSummary(env, "job-a", "queued", "completed", "2026-08-27T09:00:02.000Z");
  await updateAiQueueSummary(env, "job-a", "completed", "failed", "2026-08-27T09:00:03.000Z");
  response = await handleApi(new Request("https://example.test/api/operations"), env, new URL("https://example.test/api/operations"));
  assert.equal((await response.json()).components.ai.queueDepth, 1);
});

test("stale AI active jobs are removed instead of reporting a false healthy queue", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE };
  await updateAiQueueSummary(env, "stale-job", null, "running", "2026-08-31T00:00:00.000Z");

  const response = await handleApi(new Request("https://example.test/api/operations"), env, new URL("https://example.test/api/operations"));
  const body = await response.json();
  assert.equal(body.components.ai.queueDepth, 0);
  assert.equal(body.components.ai.status, "unknown");
  assert.equal(STOCK_STATE.values.has("ai-active:stale-job"), false);
});

test("operations snapshot aggregates failures, latency, snapshot age, and recovery", () => {
  const snapshot = buildOperationsSnapshot({
    now: Date.parse("2026-08-27T10:00:00.000Z"),
    status: { ai: { observedAt: "2026-08-27T09:59:00.000Z", queueDepth: 3 } },
    events: [
      { eventId: "ai-1", component: "ai", outcome: "success", durationMs: 100, occurredAt: "2026-08-27T09:50:00.000Z" },
      { eventId: "ai-2", component: "ai", outcome: "failure", errorCategory: "timeout", durationMs: 200, occurredAt: "2026-08-27T09:55:00.000Z" },
      { eventId: "ai-3", component: "ai", outcome: "failure", errorCategory: "timeout", durationMs: 300, occurredAt: "2026-08-27T09:56:00.000Z" },
      { eventId: "ai-4", component: "ai", outcome: "recovery", durationMs: 400, occurredAt: "2026-08-27T09:59:00.000Z" },
    ],
  });

  assert.equal(snapshot.components.ai.status, "healthy");
  assert.equal(snapshot.components.ai.lastSuccessAt, "2026-08-27T09:59:00.000Z");
  assert.equal(snapshot.components.ai.lastFailureAt, "2026-08-27T09:56:00.000Z");
  assert.equal(snapshot.components.ai.consecutiveFailures, 0);
  assert.equal(snapshot.components.ai.p95DurationMs, 400);
  assert.equal(snapshot.components.ai.snapshotAgeMs, 60_000);
  assert.equal(snapshot.components.ai.queueDepth, 3);
  assert.deepEqual(snapshot.components.ai.recovery, { occurredAt: "2026-08-27T09:59:00.000Z", errorCategory: null });
});

test("notifies once per component state transition and once on recovery", async () => {
  const STOCK_STATE = createMemoryKv();
  const now = Date.UTC(2026, 7, 28, 2, 5);
  const first = await transitionComponentState({ STOCK_STATE }, "market", "degraded", { errorCategory: "rate_limit" }, now);
  const duplicate = await transitionComponentState({ STOCK_STATE }, "market", "degraded", { errorCategory: "rate_limit" }, now + 5 * 60_000);
  const recovered = await transitionComponentState({ STOCK_STATE }, "market", "healthy", {}, now + 20 * 60_000);

  assert.equal(first.changed, true);
  assert.equal(first.notification.type, "component_degraded");
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.notification, null);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.notification.type, "component_recovered");
  const notifications = JSON.parse(STOCK_STATE.values.get("notifications:latest"));
  assert.equal(notifications.length, 2);
  assert.doesNotMatch(JSON.stringify(notifications), /https?:|token|stack|secret/i);
});

test("falls back from the primary Tushare source to ProMax", async () => {
  const calls = [];
  const rows = await tushareQuery({
    TUSHARE_PRIMARY_TOKEN: "expired",
    TUSHARE_PRIMARY_API_URL: "https://primary.example.test",
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
  }, "trade_cal", { exchange: "SSE", start_date: "20260824" }, "exchange,cal_date,is_open", async (url, init) => {
    calls.push({ url: String(url), method: init?.method || "GET", key: init?.headers?.["X-API-Key"] });
    if (String(url).includes("primary.example.test")) {
      return new Response(JSON.stringify({ code: 2002, msg: "token expired" }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: 0,
      msg: "",
      data: { fields: ["exchange", "cal_date", "is_open"], items: [["SSE", "20260824", 1]] },
    }), { status: 200 });
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[1].key, "fallback-secret");
  assert.match(calls[1].url, /trade_cal\?exchange=SSE&start_date=20260824/);
  assert.deepEqual(rows, [{ exchange: "SSE", cal_date: "20260824", is_open: 1 }]);
});

test("normalizes ProMax trade_time into an auditable quote timestamp", () => {
  const quote = normalizeIntradayRow({
    ts_code: "000001.SZ",
    name: "平安银行",
    trade_time: "2026-08-26 15:00:00",
    close: 11.73,
    open: 11.65,
    high: 11.8,
    low: 11.6,
    vol: 1200,
    amount: 1407600,
  }, "2026-08-26T07:01:00.000Z", "ProMax rt_min");

  assert.equal(quote.code, "000001");
  assert.equal(quote.name, "平安银行");
  assert.equal(quote.amountUnit, "yuan");
  assert.equal(quote.observedAt, "2026-08-26 15:00:00");
  assert.equal(quote.time, "2026-08-26 15:00:00");
  assert.equal(quote.snapshotAt, "2026-08-26T07:01:00.000Z");
  assert.equal(quote.provider, "ProMax rt_min");
  assert.equal(quote.freshness, "live");
});

test("uses snapshot time for legacy quotes without pretending it is an observed trade", () => {
  const snapshot = normalizeMarketSnapshot({
    meta: { generatedAt: "2026-08-26T06:00:47.248Z", provider: "Tushare rt_min" },
    quotes: [{ code: "600000", tsCode: "600000.SH", price: 10.2, time: null }],
  });

  assert.equal(snapshot.quotes[0].observedAt, null);
  assert.equal(snapshot.quotes[0].snapshotAt, "2026-08-26T06:00:47.248Z");
  assert.equal(snapshot.quotes[0].time, "2026-08-26T06:00:47.248Z");
  assert.equal(snapshot.quotes[0].freshness, "snapshot");
});

test("uses one ProMax rt_k batch when the ProMax minute endpoint times out", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("subscription:browser", JSON.stringify({
    clientId: "browser",
    watchlist: [{ code: "000001" }, { code: "600036" }],
  }));
  const calls = [];
  const response = await marketPulseJob({
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 2, 30), async (url) => {
    const endpoint = new URL(url);
    calls.push(`${endpoint.pathname}?${endpoint.searchParams}`);
    if (endpoint.pathname.endsWith("/rt_min")) {
      return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 504 });
    }
    if (endpoint.pathname.endsWith("/rt_k")) {
      return new Response(JSON.stringify({
        code: 0,
        msg: "ok",
        data: {
          fields: ["ts_code", "trade_time", "name", "pre_close", "open", "high", "low", "close", "vol", "amount", "num", "ask_price1", "ask_volume1", "bid_price1", "bid_volume1", "updated_at"],
          items: [
            ["600036.SH", "20260826", "招商银行", 39.5, 39.41, 39.98, 39.38, 39.8, 64645543, 2574006915, 121533, 39.81, 500, 39.8, 112577, "2026-08-26T10:30:05.000"],
            ["000001.SZ", "20260826", "平安银行", 11.59, 11.55, 11.75, 11.52, 11.73, 116728878, 1363009729, 84533, 11.73, 141745, 11.72, 28500, "2026-08-26T10:30:04.000"],
          ],
        },
      }), { status: 200 });
    }
    throw new Error(`Unexpected endpoint ${endpoint.pathname}`);
  });

  assert.equal(response.status, "completed");
  assert.deepEqual(calls, [
    "/tushare/pro/rt_min?ts_code=000001.SZ%2C600036.SH&freq=1MIN",
    "/tushare/pro/rt_k?ts_code=000001.SZ%2C600036.SH",
  ]);
  const snapshot = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(snapshot.meta.provider, "ProMax rt_k");
  assert.equal(snapshot.meta.successCount, 2);
  assert.equal(snapshot.quotes.find((item) => item.code === "600036").observedAt, "2026-08-26T10:30:05.000");
});

test("uses one ProMax rt_k batch for the requested stock set", async () => {
  const STOCK_STATE = createMemoryKv();
  const codes = ["000001", "000002", "000004", "000005", "000006", "000007", "000008", "000009", "000010", "000011", "000012"];
  STOCK_STATE.values.set("subscription:browser", JSON.stringify({
    clientId: "browser",
    watchlist: codes.map((code) => ({ code })),
  }));
  const rtKBatchSizes = [];
  const response = await marketPulseJob({
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 2, 30), async (url) => {
    const endpoint = new URL(url);
    const requested = endpoint.searchParams.get("ts_code").split(",");
    if (endpoint.pathname.endsWith("/rt_min")) {
      return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 504 });
    }
    rtKBatchSizes.push(requested.length);
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        fields: ["ts_code", "trade_time", "open", "high", "low", "close", "vol", "amount", "updated_at"],
        items: requested.map((tsCode) => [tsCode, "20260826", 10, 11, 9, 10.5, 1000, 10500, "2026-08-26T10:30:05.000"]),
      },
    }), { status: 200 });
  });

  assert.equal(response.status, "completed");
  assert.deepEqual(rtKBatchSizes, [11]);
  const snapshot = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(snapshot.meta.successCount, 11);
});

test("does not fan out after a failed ProMax batch", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("subscription:browser", JSON.stringify({
    clientId: "browser",
    watchlist: [{ code: "000001" }, { code: "600000" }, { code: "600036" }],
  }));
  STOCK_STATE.values.set("market:latest", JSON.stringify({
    meta: { generatedAt: "2026-08-26T01:30:00.000Z", provider: "opening-auction" },
    quotes: [{ code: "600000", tsCode: "600000.SH", price: 10.2, observedAt: "2026-08-26 09:25:00" }],
  }));
  const response = await marketPulseJob({
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 2, 30), async (url) => {
    const endpoint = new URL(url);
    const requested = endpoint.searchParams.get("ts_code").split(",");
    if (endpoint.pathname.endsWith("/rt_min")) {
      return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 504 });
    }
    if (requested.includes("600000.SH")) {
      return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 504 });
    }
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        fields: ["ts_code", "trade_time", "open", "high", "low", "close", "vol", "amount", "updated_at"],
        items: requested.map((tsCode) => [tsCode, "20260826", 10, 11, 9, 10.5, 1000, 10500, "2026-08-26T10:30:05.000"]),
      },
    }), { status: 200 });
  });

  assert.equal(response.status, "degraded");
  assert.equal(response.quoteCount, 0);
  assert.equal(response.retainedSnapshot, true);
  const snapshot = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(snapshot.quotes[0].code, "600000");
});

test("keeps previous quotes when ProMax only returns part of the requested watchlist", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("subscription:browser", JSON.stringify({
    clientId: "browser",
    watchlist: [{ code: "000001" }, { code: "600000" }],
  }));
  STOCK_STATE.values.set("market:latest", JSON.stringify({
    meta: { generatedAt: "2026-08-26T01:30:00.000Z", provider: "opening-auction" },
    quotes: [{ code: "600000", tsCode: "600000.SH", price: 10.2, observedAt: "2026-08-26 09:25:00" }],
  }));
  const calls = new Map();
  const response = await marketPulseJob({
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 2, 30), async (url) => {
    const tsCode = new URL(url).searchParams.get("ts_code");
    calls.set(tsCode, (calls.get(tsCode) || 0) + 1);
    if (tsCode === "600000.SH") return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 504 });
    return new Response(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        fields: ["ts_code", "trade_time", "open", "close", "high", "low", "vol", "amount"],
        items: [["000001.SZ", "2026-08-26 10:30:00", 11.65, 11.73, 11.8, 11.6, 1200, 1407600]],
      },
    }), { status: 200 });
  });

  assert.equal(response.status, "partial");
  assert.equal(response.quoteCount, 2);
  assert.equal(calls.get("000001.SZ,600000.SH"), 1);
  assert.equal(calls.get("600000.SH"), 1);
  const snapshot = JSON.parse(STOCK_STATE.values.get("market:latest"));
  assert.equal(snapshot.meta.successCount, 1);
  assert.equal(snapshot.meta.staleCount, 1);
  assert.equal(snapshot.quotes.find((item) => item.code === "000001").observedAt, "2026-08-26 10:30:00");
  assert.equal(snapshot.quotes.find((item) => item.code === "600000").freshness, "stale");
});

test("labels a partial ProMax minute snapshot without downgrading it to auction data", () => {
  const health = marketSnapshotState({
    meta: { provider: "ProMax rt_min", status: "partial", generatedAt: "2026-08-26T02:30:00.000Z" },
  }, { session: "morning" }, { status: "partial" }, Date.UTC(2026, 7, 26, 2, 31));

  assert.equal(health.status, "partial");
  assert.equal(health.isIntraday, true);
  assert.match(health.label, /部分股票/);
});

test("never labels an old intraday snapshot as live outside market hours", () => {
  const health = marketSnapshotState({
    meta: { provider: "ProMax rt_min", generatedAt: "2026-08-26T06:00:00.000Z" },
  }, { session: "lunch" }, null, Date.UTC(2026, 7, 29, 4, 0));

  assert.equal(health.status, "degraded");
  assert.equal(health.isIntraday, true);
  assert.match(health.label, /已过期/);
});

test("labels ProMax rt_k as live in session and as a close snapshot after hours", () => {
  const market = {
    meta: { provider: "ProMax rt_k", tradeDate: "2026-08-26", generatedAt: "2026-08-26T07:32:52.000Z" },
  };
  const intraday = marketSnapshotState(
    market,
    { session: "afternoon" },
    { status: "live", provider: "ProMax rt_k", succeededAt: "2026-08-26T07:32:52.000Z" },
    Date.UTC(2026, 7, 26, 7, 33),
  );
  const afterHours = marketSnapshotState(
    market,
    { session: "after_hours" },
    { status: "live", provider: "ProMax rt_k", succeededAt: "2026-08-26T07:32:52.000Z" },
    Date.UTC(2026, 7, 26, 10, 0),
  );

  assert.equal(intraday.status, "live");
  assert.match(intraday.label, /盘中日线快照.*报价距今.*8轮计划采集，非实时/);
  assert.equal(afterHours.status, "ready");
  assert.equal(afterHours.label, "今日收盘行情快照");
});

test("labels the previous trading-day rt_k snapshot honestly before the next open", () => {
  const health = marketSnapshotState({
    meta: { provider: "ProMax rt_k", tradeDate: "2026-08-26", generatedAt: "2026-08-26T12:46:32.071Z" },
  }, { session: "pre_market" }, {
    status: "live",
    provider: "ProMax rt_k",
    succeededAt: "2026-08-26T12:46:32.071Z",
  }, Date.UTC(2026, 7, 27, 0, 48));

  assert.equal(health.status, "ready");
  assert.equal(health.label, "最近交易日收盘行情快照");
});

test("does not expose raw provider errors in public market health", () => {
  const health = marketSnapshotState({
    meta: { provider: "Tushare rt_min", generatedAt: "2026-08-26T02:30:00.000Z" },
  }, { session: "morning" }, {
    status: "degraded",
    provider: "Tushare rt_min",
    failedAt: "2026-08-26T02:31:00.000Z",
    reason: "primary: rate limit; fallback: HTTP 504; token=secret",
  }, Date.UTC(2026, 7, 26, 2, 32));

  assert.equal(health.status, "degraded");
  assert.equal(health.sourceState.provider, "Tushare rt_min");
  assert.equal(health.sourceState.failedAt, "2026-08-26T02:31:00.000Z");
  assert.equal("reason" in health.sourceState, false);
});

test("falls back to the legacy Tushare HTTP source when primary and ProMax fail", async () => {
  const calls = [];
  const rows = await tushareQuery({
    TUSHARE_PRIMARY_TOKEN: "limited",
    TUSHARE_PRIMARY_API_URL: "https://primary.example.test",
    TUSHARE_FALLBACK_URL: "https://fallback.example.test/tushare/pro",
    TUSHARE_FALLBACK_API_KEY: "fallback-secret",
    TUSHARE_TOKEN: "legacy-secret",
    TUSHARE_API_URL: "https://legacy.example.test",
  }, "rt_min", { ts_code: "600036.SH", freq: "1MIN" }, "", async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes("primary.example.test")) {
      return new Response(JSON.stringify({ code: 2002, msg: "frequency exceeded" }), { status: 200 });
    }
    if (String(url).includes("fallback.example.test")) return new Response("gateway timeout", { status: 504 });
    return new Response(JSON.stringify({
      code: 0,
      msg: "",
      data: { fields: ["ts_code", "close"], items: [["600036.SH", 39.6]] },
    }), { status: 200 });
  });

  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /legacy\.example\.test/);
  assert.equal(calls[2].body.token, "legacy-secret");
  assert.deepEqual(rows, [{ ts_code: "600036.SH", close: 39.6 }]);
});

test("does not replace an unavailable real AI provider with a canned answer", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/ai/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "分析中际旭创" }),
  }), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "configuration_required");
  assert.match(body.reason, /OPENAI_API_KEY/);
});

test("uses MiniMax M3 as the primary real AI provider", async () => {
  const calls = [];
  const result = await requestAI({
    STOCK_STATE: createMemoryKv(),
    MINIMAX_API_KEY: "secret",
    MINIMAX_BASE_URL: "https://api.minimaxi.com/v1",
    MINIMAX_MODEL: "MiniMax-M3",
  }, "分析问题", "只依据上下文", async (url, init) => {
    calls.push({ url, authorization: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      id: "chat-1",
      model: "MiniMax-M3",
      choices: [{ message: { content: "<think>内部推理</think>结论与风险纪律" } }],
      usage: { total_tokens: 123 },
      base_resp: { status_code: 0, status_msg: "" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.equal(calls[0].url, "https://api.minimaxi.com/v1/text/chatcompletion_v2");
  assert.equal(calls[0].authorization, "Bearer secret");
  assert.equal(calls[0].body.model, "MiniMax-M3");
  assert.equal(result.provider, "MiniMax");
  assert.equal(result.text, "结论与风险纪律");
});

test("resolves one or multiple teacher Agents without duplicates", () => {
  assert.deepEqual(resolveTeacherProfiles([], { name: "谭琦" }).map((item) => item.name), ["谭琦"]);
  assert.deepEqual(
    resolveTeacherProfiles(["陈江挺", { name: "养家" }, "陈江挺", "不存在"], null).map((item) => item.name),
    ["陈江挺", "养家"],
  );
});

test("uses TOP50 only as supporting context when AI research has no selected stock", () => {
  const top50 = {
    meta: { generatedAt: "2026-08-24T09:25:00.000Z", marketProvider: "test" },
    cycles: {
      波段: { ranking: [{ name: "样本一", code: "000001", score: 70, probabilityUp: 0.6, agentVotes: 8 }] },
    },
  };
  const sources = buildStructuredResearchSources(top50, null, "");
  assert.equal(sources[0].title, "TOP50候选池参考快照");
  assert.match(sources[0].excerpt, /波段前列：样本一/);
  assert.doesNotMatch(sources[0].title, /样本一 TOP50/);
  assert.deepEqual(buildStructuredResearchSources(top50, null, "603893"), []);
  assert.equal(buildStructuredResearchSources(top50, null, "000001")[0].title, "样本一 TOP50冻结快照");
  const sourcesWithMarket = buildStructuredResearchSources(top50, null, "", {
    meta: { generatedAt: "2026-08-26T06:00:47.248Z", provider: "Tushare rt_min" },
    quotes: [{ code: "000001", price: 11.73, freshness: "snapshot" }],
  });
  assert.equal(sourcesWithMarket.find((item) => item.id === "M1").title, "监控池行情快照");
  assert.match(sourcesWithMarket.find((item) => item.id === "M1").excerpt, /1只监控股票/);
});

test("stratifies selected-stock news and does not pad with unrelated headlines", () => {
  const news = { items: [
    { id: "1", title: "瑞芯微发布新产品", summary: "公司芯片业务更新", source: "A", url: "https://news.test/1", publishedAt: "2026-08-24T08:00:00Z", type: "公司", market: "A股/中国", marketImpact: [] },
    { id: "2", title: "半导体设备景气回升", summary: "晶圆厂资本开支增加", source: "B", url: "https://news.test/2", publishedAt: "2026-08-24T07:00:00Z", type: "市场", market: "A股/中国", marketImpact: ["半导体"] },
    { id: "3", title: "美联储政策信号变化", summary: "全球风险偏好波动", source: "C", url: "https://news.test/3", publishedAt: "2026-08-24T06:00:00Z", type: "宏观", market: "美股/全球", marketImpact: ["风险偏好"] },
    { id: "4", title: "白酒渠道库存下降", summary: "食品饮料行业消息", source: "D", url: "https://news.test/4", publishedAt: "2026-08-24T09:00:00Z", type: "市场", market: "A股/中国", marketImpact: [] },
  ] };
  const sources = buildResearchSources(news, [], "分析风险", { code: "603893", name: "瑞芯微", industry: "半导体" });
  assert.deepEqual(sources.map((item) => item.scope), ["个股直接相关", "行业传导", "宏观/海外影响"]);
  assert.ok(sources.every((item) => !item.title.includes("白酒")));
});

test("keeps the multi-Agent final summary and collapsible opinion output in the UI", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /多 Agent 最终输出/);
  assert.match(source, /最终总结/);
  assert.match(source, /agent-opinion-details/);
  assert.match(source, /failedAgentNames/);
});

test("derives live Agent progress from agentStates instead of stale counters", () => {
  const progress = deriveAgentProgress({
    independentSuccessCount: 0,
    independentFailureCount: 0,
    agentStates: [
      { teacherName: "老师1", status: "completed" },
      { teacherName: "老师2", status: "failed" },
      { teacherName: "老师3", status: "retrying" },
    ],
  }, ["老师1", "老师2", "老师3"]);

  assert.equal(progress.independentCompletedCount, 1);
  assert.equal(progress.independentFailureCount, 1);
  assert.equal(progress.liveAgentTotal, 3);
});

test("keeps failed jobs visible after polling stops", () => {
  assert.equal(shouldKeepAgentJob({ status: "failed" }), true);
  assert.equal(shouldKeepAgentJob({ pollingState: "deadline_exceeded" }), true);
  assert.equal(shouldKeepAgentJob({ status: "completed" }), false);
  assert.equal(shouldShowAgentRunStatus({ sending: false, agentJob: { status: "failed" } }), true);
  assert.equal(shouldShowAgentRunStatus({ sending: false, agentJob: { status: "completed" } }), false);
});

test("renders summary_timeout and summary_unavailable as partial final-summary states", () => {
  const timeoutState = deriveSummaryState({ summaryStatus: "summary_timeout", fallbackMode: null, failedAgents: 0 });
  const unavailableState = deriveSummaryState({ summaryStatus: "summary_unavailable", fallbackMode: null, failedAgents: 0 });
  const completeState = deriveSummaryState({ summaryStatus: "complete", fallbackMode: null, failedAgents: 0 });

  assert.deepEqual(timeoutState, {
    coordinatorFallback: false,
    summaryTimedOut: true,
    summaryUnavailable: false,
    partial: true,
    label: "综合超时",
  });
  assert.deepEqual(unavailableState, {
    coordinatorFallback: false,
    summaryTimedOut: false,
    summaryUnavailable: true,
    partial: true,
    label: "综合未生成",
  });
  assert.deepEqual(completeState, {
    coordinatorFallback: false,
    summaryTimedOut: false,
    summaryUnavailable: false,
    partial: false,
    label: "全部完成",
  });
});

test("AI lab exposes independent fallback and deadline polling semantics", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

  assert.match(source, /共享模型降级/);
  assert.match(source, /未计入老师共识/);
  assert.match(source, /任务已超过执行上限/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /publicMessage/);
  assert.match(source, /deadlineAt/);
  assert.match(source, /独立完成/);
  assert.match(styles, /scroll-padding-bottom: 220px/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
});

test("incremental consultation checkpoints each teacher, freezes context and resumes idempotently", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, MINIMAX_API_KEY: "test", MINIMAX_MODEL: "MiniMax-M3" };
  let calls = 0;
  let release;
  let gate = null;
  const provider = async () => {
    calls += 1;
    if (gate) await gate;
    return new Response(JSON.stringify({ choices: [{ message: { content: `独立观点${calls}，最终总结：仅依据证据。` } }] }));
  };
  const post = async (path, body) => {
    const url = new URL(path, "https://example.test");
    return handleApi(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, url, provider);
  };
  const accepted = await (await post("/api/ai/jobs", { clientId: "steps", question: "分步验收", teachers: [{ name: "谭琦" }, { name: "养家" }], incremental: true })).json();
  assert.equal(calls, 0);
  const path = `/api/ai/jobs/${accepted.job.id}/advance`;
  gate = new Promise((resolve) => { release = resolve; });
  const firstRequest = post(path, { clientId: "steps", step: 0 });
  while (!calls) await new Promise((resolve) => setTimeout(resolve, 1));
  const duplicate = await (await post(path, { clientId: "steps", step: 0 })).json();
  assert.equal(duplicate.busy, true);
  assert.equal(calls, 1);
  release(); gate = null;
  const first = await (await firstRequest).json();
  assert.equal(first.job.step, 1);
  assert.equal(first.job.checkpoint.agentResponses.length, 1);
  assert.equal(first.job.agentStates.filter((item) => item.status === "completed").length, first.job.checkpoint.agentResponses.length);
  const initialThread = JSON.parse(STOCK_STATE.values.get(`ai-thread:steps:${accepted.job.threadId}`));
  assert.deepEqual(initialThread.teacherNames, ["谭琦", "养家"]);
  const frozen = STOCK_STATE.values.get(`ai-context:${accepted.job.id}`);
  await STOCK_STATE.put("market:latest", JSON.stringify({ meta: { generatedAt: "2099-01-01" }, quotes: [] }));
  await post(path, { clientId: "steps", step: 0 });
  assert.equal(calls, 1, "stale retry does not call the provider");
  const wrongClient = await post(path, { clientId: "other", step: 1 });
  assert.equal(wrongClient.status, 404);
  const second = await (await post(path, { clientId: "steps", step: 1 })).json();
  assert.equal(calls, 2);
  assert.equal(second.job.phase, "summarizing");
  assert.equal(second.job.checkpoint.agentResponses.length, 2);
  assert.equal(STOCK_STATE.values.get(`ai-context:${accepted.job.id}`), frozen);
  const threadKey = `ai-thread:steps:${accepted.job.threadId}`;
  assert.equal(JSON.parse(STOCK_STATE.values.get(threadKey)).messages.length, 1);
  const completed = await (await post(path, { clientId: "steps", step: 2 })).json();
  assert.equal(calls, 3);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.result.summaryStatus, "complete");
  assert.equal(completed.job.result.agentResponses.length, 2);
  const thread = JSON.parse(STOCK_STATE.values.get(threadKey));
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.activeJobId, null);
  await post(path, { clientId: "steps", step: 2 });
  assert.equal(calls, 3);
  assert.equal(JSON.parse(STOCK_STATE.values.get(threadKey)).messages.length, 2);
});

test("incremental queue preserves failed teachers and does not rerun completed attempts", async () => {
  const teachers = [{ name: "one" }, { name: "two" }];
  let calls = 0;
  const request = async (teacher) => {
    calls += 1;
    if (teacher.name === "one") throw Object.assign(new Error("invalid API key"), { status: 401 });
    return { text: "有效独立观点", model: "test" };
  };
  const first = await runTeacherQueue(teachers, { request, oneStep: true });
  assert.deepEqual(first.failedAgentNames, ["one"]);
  const second = await runTeacherQueue(teachers, { request, oneStep: true, checkpoint: first });
  assert.equal(calls, 2);
  const result = await runTeacherQueue(teachers, { request, oneStep: true, checkpoint: second });
  assert.equal(calls, 2);
  assert.equal(result.independentSuccessCount, 1);
  assert.equal(result.independentFailureCount, 1);
  assert.equal(result.consensus.agentCount, 1);
});

test("runs AI research as a pollable background job with per-Agent states", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, MINIMAX_API_KEY: "secret", MINIMAX_MODEL: "MiniMax-M3" };
  await STOCK_STATE.put("market:latest", JSON.stringify({
    meta: { generatedAt: "2026-08-26T06:00:47.248Z", provider: "Tushare rt_min" },
    quotes: [{ code: "000001", price: 11.73, freshness: "snapshot" }],
  }));
  let backgroundTask;
  const aiRequests = [];
  const url = new URL("https://example.test/api/ai/jobs");
  const response = await handleApi(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "device-job", question: "验证监控池行情会诊", teachers: [{ name: "谭琦" }, { name: "养家" }] }),
  }), env, url, async (_requestUrl, init) => {
    aiRequests.push(String(init?.body || ""));
    return new Response(JSON.stringify({
      id: crypto.randomUUID(),
      model: "MiniMax-M3",
      choices: [{ message: { content: "观点、风险与最终总结" } }],
      base_resp: { status_code: 0, status_msg: "" },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, {
    waitUntil(promise) { backgroundTask = promise; },
  });
  const accepted = await response.json();
  assert.equal(response.status, 202);
  assert.equal(accepted.job.status, "queued");
  await backgroundTask;

  const pollUrl = new URL(`https://example.test/api/ai/jobs/${accepted.job.id}?clientId=device-job`);
  const poll = await handleApi(new Request(pollUrl), env, pollUrl);
  const completed = await poll.json();
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.phase, "completed");
  assert.ok(completed.job.agentStates.every((item) => item.status === "completed"));
  assert.equal(completed.job.result.summaryStatus, "complete");
  assert.match(aiRequests.join("\n"), /2026-08-26T06:00:47.248Z/);
  assert.match(aiRequests.join("\n"), /监控池行情快照/);

  const runRecord = JSON.parse(STOCK_STATE.values.get(`ai-run:${accepted.job.id}`));
  assert.equal(runRecord.independentSuccessCount, 2);
  assert.equal(runRecord.independentFailureCount, 0);
  assert.equal(runRecord.fallbackMode, null);
  assert.equal(runRecord.model, "MiniMax-M3");
  assert.ok(runRecord.teacherVersions.every((item) => item.version));
  assert.doesNotMatch(JSON.stringify(runRecord), /验证异步会诊|经过校验的数据上下文|经过校验的联合研究上下文|问题：/);
});

test("streamed AI acceptance is readable before completion and closes without buffering", async () => {
  let controller;
  const encoder = new TextEncoder();
  const body = new ReadableStream({ start(value) { controller = value; } });
  controller.enqueue(encoder.encode('{"status":"accepted","job":{"id":"one"}}\n'));
  const { accepted, connection } = await readAiJobConnection(new Response(body, { headers: { "content-type": "application/x-ndjson" } }));
  assert.equal(accepted.job.id, "one");
  assert.equal(connection.closed, false);
  controller.enqueue(encoder.encode("\n"));
  controller.close();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connection.closed, true);
  assert.equal(connection.failed, false);
});

test("AI streaming route holds the response until the saved job is complete", async () => {
  const env = { STOCK_STATE: createMemoryKv(), MINIMAX_API_KEY: "test" };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let background;
  const url = new URL("https://example.test/api/ai/jobs");
  const response = await handleApi(new Request(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, body: JSON.stringify({ clientId: "stream-test", question: "解释证据边界", teachers: [{ name: "谭琦" }] }) }), env, url, async () => {
    await gate;
    return new Response(JSON.stringify({ choices: [{ message: { content: "事实与假设分开。最终总结：等待核验。" } }] }));
  }, { waitUntil(promise) { background = promise; } });
  const { accepted, connection } = await readAiJobConnection(response);
  assert.equal(response.status, 202);
  assert.equal(connection.closed, false);
  release();
  await background;
  const pollUrl = new URL(`/api/ai/jobs/${accepted.job.id}?clientId=stream-test`, url);
  const saved = await (await handleApi(new Request(pollUrl), env, pollUrl)).json();
  assert.equal(saved.job.status, "completed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(connection.closed, true);
});

test("classifies AI failures without leaking provider details", () => {
  const result = classifyAiError(new Error("HTTP 429 https://api.minimax.chat?key=secret"));

  assert.deepEqual(result, {
    category: "rate_limit",
    retryable: true,
    publicMessage: "AI服务繁忙，系统已按策略重试。",
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|minimax\.chat/);
});

test("classifies AI failure categories for auth quota empty and validation errors", () => {
  const cases = [
    ["auth", new Error("HTTP 401 unauthorized"), "本次老师研判未完成，请稍后重试。"],
    ["quota", new Error("HTTP 402 usage limit exceeded"), "本次老师研判未完成，请稍后重试。"],
    ["empty_response", new Error("returned an empty response"), "本次老师研判未完成，请稍后重试。"],
    ["validation", new Error("schema validation failed"), "研究上下文过长或格式不正确，请缩短问题后重试。"],
  ];

  for (const [category, error, publicMessage] of cases) {
    const result = classifyAiError(error);
    assert.equal(result.category, category);
    assert.equal(result.retryable, false);
    assert.equal(result.publicMessage, publicMessage);
  }
});

test("MiniMax short consultations keep the token ceiling and expose truncation", async () => {
  const values = new Map();
  const env = { MINIMAX_API_KEY: "test", MINIMAX_MODEL: "MiniMax-M3", STOCK_STATE: { get: async (key) => values.get(key), put: async (key, value) => values.set(key, value) } };
  const result = await requestAI(env, "问题", "限定证据", async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.max_completion_tokens, 1100);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.max_tokens, undefined);
    return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "部分答复" } }] }));
  }, { maxTokens: 1100, shortConsultation: true });
  assert.match(result.text, /内容未完整生成/);
});

test("retries a failed AI agent once and reports state changes", async () => {
  const states = [];
  let calls = 0;
  const result = await runAgentWithRetry({
    teacher: { name: "谭琦" },
    request: async () => {
      calls += 1;
      if (calls === 1) throw new Error("HTTP 504");
      return { teacherName: "谭琦", text: "联席意见", model: "MiniMax-M3", provider: "MiniMax", usage: null };
    },
    onState: (state) => states.push(state.status),
    now: () => 0,
    sleep: async () => {},
  });

  assert.equal(calls, 2);
  assert.deepEqual(states, ["analyzing", "retrying", "completed"]);
  assert.deepEqual(result, { teacherName: "谭琦", text: "联席意见", model: "MiniMax-M3", provider: "MiniMax", usage: null });
});

test("keeps a successful agent request completed when state telemetry throws", async () => {
  const states = [];
  let calls = 0;
  const result = await runAgentWithRetry({
    teacher: { name: "谭琦" },
    request: async () => {
      calls += 1;
      return { teacherName: "谭琦", text: "联席意见", model: "MiniMax-M3", provider: "MiniMax", usage: null };
    },
    onState: (state) => {
      states.push(state.status);
      if (state.status === "analyzing") throw new Error("kv write failed");
    },
    now: () => 0,
    sleep: async () => {},
  });

  assert.equal(calls, 1);
  assert.deepEqual(states, ["analyzing", "completed"]);
  assert.deepEqual(result, { teacherName: "谭琦", text: "联席意见", model: "MiniMax-M3", provider: "MiniMax", usage: null });
});

test("runs teacher queue sequentially and preserves partial success without shared fallback", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
    { name: "老师3", version: "v3" },
  ];
  const updates = [];
  let active = 0;
  let peak = 0;
  let fallbackCalls = 0;

  const result = await runTeacherQueue(teachers, {
    request: async (teacher) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        if (teacher.name === "老师2") throw new Error("HTTP 401");
        return { teacherName: teacher.name, text: teacher.name, model: "MiniMax-M3", provider: "MiniMax", usage: null };
      } finally {
        active -= 1;
      }
    },
    sharedFallbackRequest: async () => {
      fallbackCalls += 1;
      return { teacherName: "共享模型", text: "共享总结", model: "Shared-Model", provider: "MiniMax", usage: null };
    },
    updateJob: async (job) => updates.push(job),
  });

  assert.equal(peak, 1);
  assert.equal(result.independentSuccessCount, 2);
  assert.equal(result.independentFailureCount, 1);
  assert.equal(result.fallbackMode, null);
  assert.equal(fallbackCalls, 0);
  assert.ok(updates.some((job) => job.independentSuccessCount === 1 && job.independentFailureCount === 0));
  assert.ok(updates.some((job) => job.independentSuccessCount === 1 && job.independentFailureCount === 1));
  assert.ok(updates.some((job) => job.agentStates.some((item) => item.teacherName === "老师1" && item.status === "completed")));
  assert.ok(updates.some((job) => job.agentStates.some((item) => item.teacherName === "老师2" && item.status === "failed")));
});

test("preserves per-Agent failed states and redacted reasons on the final failed job", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, MINIMAX_API_KEY: "secret", MINIMAX_MODEL: "MiniMax-M3" };
  await STOCK_STATE.put("market:latest", JSON.stringify({
    meta: { generatedAt: "2026-08-26T06:00:47.248Z", provider: "Tushare rt_min" },
    quotes: [{ code: "000001", price: 11.73, freshness: "snapshot" }],
  }));
  let backgroundTask;
  const url = new URL("https://example.test/api/ai/jobs");
  const response = await handleApi(new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "device-job-failed", question: "验证失败保留", teachers: [{ name: "谭琦" }, { name: "养家" }] }),
  }), env, url, async () => new Response("upstream down", { status: 504 }), {
    waitUntil(promise) { backgroundTask = promise; },
  });
  const accepted = await response.json();
  assert.equal(response.status, 202);
  await backgroundTask;

  const pollUrl = new URL(`https://example.test/api/ai/jobs/${accepted.job.id}?clientId=device-job-failed`);
  const poll = await handleApi(new Request(pollUrl), env, pollUrl);
  const failed = await poll.json();

  assert.equal(failed.job.status, "failed");
  assert.equal(failed.job.phase, "failed");
  assert.equal(failed.job.independentSuccessCount, 0);
  assert.equal(failed.job.independentFailureCount, 2);
  assert.ok(failed.job.agentStates.every((item) => item.status === "failed"));
  assert.ok(failed.job.agentStates.every((item) => item.publicMessage && !item.publicMessage.includes("upstream down")));
  assert.ok(failed.job.agentStates.every((item) => item.errorCategory));
  assert.doesNotMatch(JSON.stringify(failed.job), /upstream down/);
});

test("marks remaining teachers timeout when the queue deadline is exceeded", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
    { name: "老师3", version: "v3" },
  ];
  let current = 0;
  const result = await runTeacherQueue(teachers, {
    now: () => current,
    request: async (teacher) => {
      if (teacher.name === "老师1") current = 15 * 60 * 1000 + 1;
      return { teacherName: teacher.name, text: teacher.name, model: "MiniMax-M3", provider: "MiniMax", usage: null };
    },
    sharedFallbackRequest: async () => {
      throw new Error("fallback should not run");
    },
  });

  assert.equal(result.independentSuccessCount, 1);
  assert.equal(result.independentFailureCount, 2);
  assert.equal(result.fallbackMode, null);
  assert.ok(result.failedAgentNames.includes("老师2"));
  assert.ok(result.failedAgentNames.includes("老师3"));
  assert.ok(result.errorCategories.filter((item) => item === "timeout").length >= 2);
});

test("aborts an in-flight teacher request and marks the remaining queue timeout when the deadline fires", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
  ];
  const updates = [];
  const calls = [];
  let firstSignal = null;
  let requestStartedResolve = null;
  const requestStarted = new Promise((resolve) => {
    requestStartedResolve = resolve;
  });
  const timeoutError = () => {
    const error = new Error("AI request timed out after deadline");
    error.name = "TimeoutError";
    return error;
  };
  const runPromise = runTeacherQueue(teachers, {
    deadlineMs: 30,
    request: async (teacher, { signal }) => {
      calls.push(teacher.name);
      if (teacher.name !== "老师1") throw new Error("should not reach the second teacher");
      firstSignal = signal;
      requestStartedResolve?.();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
      });
    },
    sharedFallbackRequest: async () => ({ teacherName: "共享模型", text: "共享总结" }),
    updateJob: async (job) => updates.push(job),
  });
  runPromise.catch(() => {});

  await requestStarted;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(runPromise, (error) => error?.name === "TimeoutError" || error?.aiError?.category === "timeout");

  assert.deepEqual(calls, ["老师1"]);
  assert.equal(firstSignal?.aborted, true);
  assert.ok(updates.some((job) => job.agentStates.some((item) => item.teacherName === "老师1" && item.status === "failed" && item.errorCategory === "timeout")));
  assert.ok(updates.some((job) => job.agentStates.some((item) => item.teacherName === "老师2" && item.status === "failed" && item.errorCategory === "timeout")));
});

test("falls back to the shared model only after every independent teacher fails", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
  ];
  let fallbackCalls = 0;

  const result = await runTeacherQueue(teachers, {
    request: async () => {
      throw new Error("HTTP 504");
    },
    sharedFallbackRequest: async () => {
      fallbackCalls += 1;
      return { teacherName: "共享模型", text: "共享总结", model: "Shared-Model", provider: "MiniMax", usage: null };
    },
  });

  assert.equal(fallbackCalls, 1);
  assert.equal(result.independentSuccessCount, 0);
  assert.equal(result.independentFailureCount, 2);
  assert.equal(result.fallbackMode, "shared_model");
  assert.equal(result.consensus.agentCount, 0);
  assert.equal(result.fallbackResult.text, "共享总结");
});

test("aborts the shared fallback request when the queue deadline fires after all teachers fail", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
  ];
  let fallbackSignal = null;
  const timeoutError = () => {
    const error = new Error("AI request timed out after deadline");
    error.name = "TimeoutError";
    return error;
  };

  const runPromise = runTeacherQueue(teachers, {
    deadlineMs: 40,
    request: async () => {
      throw new Error("HTTP 504");
    },
    sharedFallbackRequest: async ({ signal }) => {
      fallbackSignal = signal;
      if (signal.aborted) return Promise.reject(timeoutError());
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
      });
    },
  });
  runPromise.catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(runPromise, (error) => error?.aiError?.category === "timeout");

  assert.equal(fallbackSignal?.aborted, true);
});

test("aborts a pending final synthesis at the job deadline and keeps independent results", async () => {
  const teachers = [
    { name: "老师1", version: "v1" },
    { name: "老师2", version: "v2" },
  ];
  let synthesisSignal = null;
  let synthesisStartedResolve = null;
  const synthesisStarted = new Promise((resolve) => {
    synthesisStartedResolve = resolve;
  });
  const timeoutError = () => {
    const error = new Error("AI request timed out after the job deadline");
    error.name = "TimeoutError";
    return error;
  };

  const runPromise = runTeacherQueue(teachers, {
    deadlineMs: 40,
    request: async (teacher) => ({ teacherName: teacher.name, text: teacher.name, model: "MiniMax-M3", provider: "MiniMax" }),
    synthesisRequest: async ({ signal }) => {
      synthesisSignal = signal;
      synthesisStartedResolve?.();
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(timeoutError()), { once: true });
      });
    },
  });
  runPromise.catch(() => {});

  await synthesisStarted;
  await new Promise((resolve) => setTimeout(resolve, 60));
  const result = await runPromise;

  assert.equal(synthesisSignal?.aborted, true);
  assert.equal(result.independentSuccessCount, 2);
  assert.equal(result.synthesisResult, null);
  assert.equal(result.synthesisError?.category, "timeout");
});

test("protects the system scheduler endpoint", async () => {
  const url = new URL("https://example.test/api/admin/scheduled");
  const denied = await handleApi(new Request(url, { method: "POST" }), { ADMIN_API_TOKEN: "secret" }, url);
  assert.equal(denied.status, 401);
});

test("bootstraps only validated snapshots through the protected admin endpoint", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, ADMIN_API_TOKEN: "secret" };
  const url = new URL("https://example.test/api/admin/bootstrap-snapshots");
  const denied = await handleApi(new Request(url, { method: "POST" }), env, url);
  assert.equal(denied.status, 401);

  const response = await handleApi(new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer secret", "content-type": "application/json" },
    body: JSON.stringify({
      top50: { meta: { generatedAt: "2026-08-28T07:35:00.000Z" }, cycles: { ultraShort: [] } },
      news: { meta: { generatedAt: "2026-08-29T03:00:00.000Z" }, items: [{ title: "x".repeat(70_000) }] },
      market: { meta: { generatedAt: "2026-08-28T07:00:00.000Z" }, quotes: [], health: { status: "ready" } },
    }),
  }), env, url);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).imported, ["top50", "news", "market"]);
  assert.ok(await STOCK_STATE.get("top50:latest"));
  assert.ok(await STOCK_STATE.get("news:latest"));
  assert.ok(await STOCK_STATE.get("market:latest"));
});

test("searches the cached full A-share universe by code or name", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" };
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      code: 0,
      data: {
        fields: ["ts_code", "symbol", "name", "industry", "market", "list_date"],
        items: [
          ["603893.SH", "603893", "瑞芯微", "半导体", "主板", "20190208"],
          ["000001.SZ", "000001", "平安银行", "银行", "主板", "19910403"],
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const firstUrl = new URL("https://example.test/api/stocks/search?q=%E7%91%9E%E8%8A%AF");
  const first = await handleApi(new Request(firstUrl), env, firstUrl, fetchImpl);
  const firstResult = await first.json();
  assert.equal(firstResult.items[0].code, "603893");
  assert.equal(firstResult.items[0].name, "瑞芯微");

  const secondUrl = new URL("https://example.test/api/stocks/search?q=000001");
  const second = await handleApi(new Request(secondUrl), env, secondUrl, fetchImpl);
  assert.equal((await second.json()).items[0].name, "平安银行");
  assert.equal(calls, 1);
});

test("returns true 30-day, 60-day and cached intraday average prices", async () => {
  const STOCK_STATE = createMemoryKv();
  await STOCK_STATE.put("market:latest", JSON.stringify({
    meta: { sourceMode: "live", tradeDate: "2026-08-25", provider: "ProMax rt_k" },
    quotes: [{ code: "600036", provider: "ProMax rt_k", time: "2026-08-25T15:32:52.000", price: 39.6, amount: 3960000, amountUnit: "yuan", volume: 100000, intradayVwap: null, series: [{ time: "2026-08-25T15:32:52.000", price: 39.6, volume: 100000 }] }],
  }));
  const dailyRows = Array.from({ length: 65 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 25 - index)).toISOString().slice(0, 10).replaceAll("-", "");
    return ["600036.SH", date, index + 1];
  });
  const fetchImpl = async () => new Response(JSON.stringify({
    code: 0,
    data: { fields: ["ts_code", "trade_date", "close"], items: dailyRows },
  }), { status: 200, headers: { "content-type": "application/json" } });
  const url = new URL("https://example.test/api/stocks/600036/metrics");
  const response = await handleApi(new Request(url), { STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" }, url, fetchImpl);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.ma30, 15.5);
  assert.equal(result.ma60, 30.5);
  assert.equal(result.intradayVwap, 39.6);
  assert.equal(result.intradaySeries.length, 1);
  assert.equal(result.averageMode, "daily_vwap");
  assert.equal(result.provider, "Tushare daily + ProMax rt_k");
  assert.equal(result.sampleCount, 65);
});

test("persists AI research threads and favorites by anonymous device", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { STOCK_STATE, ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } };
  const createdResponse = await worker.fetch(new Request("https://example.test/api/ai/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "device-123", title: "半导体研究", teacherName: "谭琦", teacherNames: ["谭琦", "养家"], stockCode: "603893" }),
  }), env);
  const created = await createdResponse.json();

  assert.equal(createdResponse.status, 201);
  assert.equal(created.thread.title, "半导体研究");
  assert.deepEqual(created.thread.teacherNames, ["谭琦", "养家"]);

  const favoriteResponse = await worker.fetch(new Request(`https://example.test/api/ai/threads/${created.thread.id}?clientId=device-123`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ favorite: true }),
  }), env);
  assert.equal((await favoriteResponse.json()).thread.favorite, true);

  const listResponse = await worker.fetch(new Request("https://example.test/api/ai/threads?clientId=device-123"), env);
  const list = await listResponse.json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].favorite, true);
  assert.deepEqual(list.items[0].teacherNames, ["谭琦", "养家"]);
});

test("protects teacher material ingestion and reports knowledge status", async () => {
  const STOCK_STATE = createMemoryKv();
  const env = { ADMIN_API_TOKEN: "admin-secret", STOCK_STATE, ASSETS: { fetch: async () => new Response("missing", { status: 404 }) } };
  const initialSummary = await (await worker.fetch(new Request("https://example.test/api/teachers"), env)).json();
  assert.ok(initialSummary.items.every((item) => item.materialCount === 0));
  const requestBody = JSON.stringify({
    teacherName: "谭琦",
    title: "逆向投资访谈",
    content: "先评估下限，再等待经营数据验证预期差。",
    sourceName: "授权访谈",
    sourceUrl: "https://example.test/interview",
    contentHash: "sha256-test-material",
    rightsConfirmed: true,
  });
  const denied = await worker.fetch(new Request("https://example.test/api/teachers/materials", {
    method: "POST", headers: { "content-type": "application/json" }, body: requestBody,
  }), env);
  assert.equal(denied.status, 401);

  const created = await worker.fetch(new Request("https://example.test/api/teachers/materials", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-secret" }, body: requestBody,
  }), env);
  assert.equal(created.status, 201);
  const duplicate = await worker.fetch(new Request("https://example.test/api/teachers/materials", {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer admin-secret" }, body: requestBody,
  }), env);
  assert.equal((await duplicate.json()).status, "duplicate");

  const summary = await (await worker.fetch(new Request("https://example.test/api/teachers"), env)).json();
  const teacher = summary.items.find((item) => item.name === "谭琦");
  assert.equal(summary.items.length, 12);
  assert.ok(summary.items.filter((item) => item.name !== "谭琦").every((item) => item.materialCount === 0));
  assert.equal(teacher.materialCount, 1);
  assert.equal(teacher.productionVersion.id, "agent-factor-v1");
  assert.match(summary.learningPolicy, /不会被AI自动修改/);
});

test("formats notifications for a Feishu custom bot", async () => {
  const STOCK_STATE = createMemoryKv();
  const calls = [];
  await sendNotification({
    STOCK_STATE,
    NOTIFICATION_WEBHOOK_URL: "https://open.feishu.cn/open-apis/bot/v2/hook/test-token",
  }, {
    title: "A股盘前计划",
    body: "TOP50已生成",
    level: "important",
  }, async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ code: 0, msg: "success" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(calls[0].body.msg_type, "text");
  assert.match(calls[0].body.content.text, /A股盘前计划/);
  assert.match(calls[0].body.content.text, /TOP50已生成/);
  assert.equal(JSON.parse(STOCK_STATE.values.get("notifications:latest")).length, 1);
});

test("normalizes Qinghong finance sources into the shared news contract", async () => {
  const calls = [];
  const rows = await fetchQinghongFinance({
    QINGHONG_API_KEY: "secret",
    QINGHONG_BASE_URL: "https://news.example.test",
  }, async (url, init) => {
    calls.push({ url, method: init.method, key: init.headers["X-API-Key"] });
    return new Response(JSON.stringify([{
      id: "bloomberg-markets",
      status: "cache",
      updatedTime: 1785402601428,
      items: [{
        id: "story-1",
        title: "Nasdaq rises as chip shares rally",
        url: "https://example.test/story-1",
        pubDate: 1785349920000,
        extra: { hover: "Global risk appetite improved." },
      }],
    }]), { status: 200, headers: { "content-type": "application/json" } });
  });

  assert.deepEqual(calls, [{
    url: "https://news.example.test/api/finance/entire",
    method: "POST",
    key: "secret",
  }]);
  assert.equal(rows[0].provider, "晴红50+");
  assert.equal(rows[0].source.name, "Bloomberg");
  assert.equal(rows[0].sourceId, "bloomberg-markets");
  assert.equal(rows[0].sourceStatus, "cache");
});

test("removes hot-stock placeholders and duplicate titles from the news feed", () => {
  const generatedAt = "2026-08-25T01:00:00.000Z";
  const items = filterUniqueNewsArticles([
    { title: "英伟达", url: "https://xueqiu.com/s/NVDA", sourceId: "xueqiu-hotstock", publishedAt: generatedAt },
    { title: "请问公司是否重视股价", url: "https://sns.sseinfo.com/a", sourceId: "sseinfo-qa", publishedAt: generatedAt },
    { title: "央行开展MLF操作", url: "https://news.test/a", sourceId: "cls", publishedAt: generatedAt },
    { title: "央行开展 MLF 操作！", url: "https://news.test/b", sourceId: "other", publishedAt: generatedAt },
  ], generatedAt);
  assert.deepEqual(items.map((item) => item.url), ["https://news.test/a"]);
  const normalized = normalizeNews([{ title: "5000亿MLF、隔夜逆回购双箭齐发", description: "多家公司关注资金面", source: { name: "测试" }, url: "https://news.test/macro", publishedAt: generatedAt }], generatedAt);
  assert.equal(normalized.items[0].type, "宏观");
});

test("scores auditable A-share relevance and rejects entertainment", () => {
  const generatedAt = "2026-08-27T09:30:00.000Z";
  const primary = scoreNewsArticle(makeCninfoDisclosure(), generatedAt);

  assert.deepEqual(Object.keys(primary.scoreBreakdown), [
    "sourceTrust",
    "financialRelevance",
    "timeliness",
    "entityMatch",
    "aShareTransmission",
  ]);
  assert.equal(primary.score, Object.values(primary.scoreBreakdown).reduce((sum, value) => sum + value, 0));
  assert.equal(primary.scoreBreakdown.sourceTrust, 25);
  assert.equal(primary.scoreBreakdown.financialRelevance, 25);
  assert.equal(primary.scoreBreakdown.timeliness, 20);
  assert.equal(primary.scoreBreakdown.entityMatch, 20);
  assert.equal(primary.scoreBreakdown.aShareTransmission, 10);
  assert.equal(primary.score, 100);
  assert.equal(primary.tier, "primary");
  assert.equal(primary.rejected, false);

  const noise = scoreNewsArticle({
    title: "明星综艺热搜引发网友讨论",
    description: "娱乐圈八卦持续发酵",
    sourceId: "weibo",
    publishedAt: "2026-08-27T09:25:00.000Z",
    url: "https://example.test/noise",
  }, generatedAt);

  assert.equal(noise.score, 0);
  assert.equal(noise.rejected, true);
  assert.equal(noise.rejectionReason, "entertainment");
  assert.equal(noise.tier, "rejected");
});

test("routes a score-97 global primary item only into 主要", () => {
  const generatedAt = "2026-08-27T09:30:00.000Z";
  const snapshot = normalizeNews([{
    title: "Federal Reserve signals slower rate cuts as Nvidia slips",
    description: "Treasury yields moved higher overnight while A-share risk appetite tracks the move.",
    publishedAt: "2026-08-27T09:00:00.000Z",
    sourceId: "bloomberg-markets",
    source: { name: "Bloomberg" },
    url: "https://example.test/global-primary",
  }], generatedAt, ["Bloomberg"]);

  const item = snapshot.items[0];
  const buckets = Object.fromEntries(newsCategories.map((category) => [
    category,
    snapshot.items.filter((news) => newsCategoryMatches(news, category)).map((news) => news.id),
  ]));

  assert.equal(item.score, 97);
  assert.equal(item.tier, "primary");
  assert.equal(newsTierLabel(item), "主要");
  assert.deepEqual(buckets, {
    主要: [item.id],
    普通: [],
    观察: [],
  });
});

test("keeps ordinary ETF wording out of the global bucket and classifies US and Hong Kong news", () => {
  const snapshot = normalizeNews([
    makeCninfoDisclosure({
      title: "公司回应创业板ETF持仓变化并披露回购进展",
      url: "https://example.test/a-share-etf",
    }),
    {
      title: "Federal Reserve signals slower rate cuts as Nasdaq slips",
      description: "Treasury yields moved higher overnight.",
      publishedAt: "2026-08-27T08:40:00.000Z",
      sourceId: "bloomberg-markets",
      source: { name: "Bloomberg" },
      url: "https://example.test/us-macro",
    },
    {
      title: "港交所就恶劣天气下维持交易咨询市场",
      description: "香港市场基础设施调整。",
      publishedAt: "2026-08-27T08:20:00.000Z",
      sourceId: "hkex-news",
      source: { name: "港交所" },
      url: "https://example.test/hkex",
    },
  ], "2026-08-27T09:30:00.000Z", ["测试源"]);

  const aShare = snapshot.items.find((item) => item.url === "https://example.test/a-share-etf");
  const us = snapshot.items.find((item) => item.url === "https://example.test/us-macro");
  const hk = snapshot.items.find((item) => item.url === "https://example.test/hkex");

  assert.equal(aShare.market, "A股/中国");
  assert.equal(aShare.classificationReason, "domestic_source");
  assert.equal(aShare.marketScope.market, "A股/中国");
  assert.equal(us.market, "美股/全球");
  assert.equal(us.classificationReason, "explicit_global_marker");
  assert.equal(hk.market, "港股");
  assert.equal(hk.classificationReason, "explicit_hong_kong_marker");

  const watch = scoreNewsArticle({
    title: "美债震荡，市场保持观望",
    description: "投资者等待下一批数据公布。",
    publishedAt: "2026-08-10T09:00:00.000Z",
    sourceId: "unknown",
    url: "https://example.test/watch",
  }, "2026-08-27T09:30:00.000Z");

  assert.equal(watch.tier, "watch");
  assert.equal(newsTierLabel(watch), "观察");
  assert.equal(newsCategoryMatches(watch, "观察"), true);
});

test("normalizes news with market scope, entities, industries, score breakdown and transmission path", () => {
  const article = {
    title: "华尔街聚焦英伟达财报，半导体板块波动加大",
    description: "纳斯达克芯片股震荡，A股算力链关注景气传导。",
    publishedAt: "2026-08-27T09:00:00.000Z",
    sourceId: "bloomberg-technology",
    source: { name: "Bloomberg" },
    url: "https://example.test/nvda",
  };

  const entities = inferNewsEntities(article);
  assert.ok(entities.relatedStocks.includes("英伟达"));
  assert.ok(entities.relatedIndustries.includes("半导体芯片"));
  assert.ok(entities.transmissionPath.length > 0);

  const snapshot = normalizeNews([article], "2026-08-27T09:30:00.000Z", ["Bloomberg"]);
  const item = snapshot.items[0];

  assert.equal(item.marketScope.market, "美股/全球");
  assert.equal(item.classificationReason, "explicit_global_marker");
  assert.equal(item.score, Object.values(item.scoreBreakdown).reduce((sum, value) => sum + value, 0));
  assert.equal(item.scoreBreakdown.sourceTrust, 22);
  assert.ok(item.relatedStocks.includes("英伟达"));
  assert.ok(item.relatedIndustries.includes("半导体芯片"));
  assert.ok(item.transmissionPath.length > 0);
});

test("deduplicates normalized titles within six hours and keeps the most trusted lead source", () => {
  const generatedAt = "2026-08-27T09:30:00.000Z";
  const items = filterUniqueNewsArticles([
    {
      title: "央行开展 MLF 操作，净投放保持合理充裕",
      description: "资金面保持平稳。",
      publishedAt: "2026-08-27T09:00:00.000Z",
      sourceId: "other-wire",
      source: { name: "Other Wire" },
      url: "https://example.test/mlf-other",
    },
    {
      title: "央行开展MLF操作净投放保持合理充裕",
      description: "财联社跟进报道。",
      publishedAt: "2026-08-27T08:30:00.000Z",
      sourceId: "cls",
      source: { name: "财联社" },
      url: "https://example.test/mlf-cls",
    },
    {
      title: "央行开展MLF操作净投放保持合理充裕",
      description: "更早的同题报道。",
      publishedAt: "2026-08-27T01:00:00.000Z",
      sourceId: "jqka-flash",
      source: { name: "同花顺" },
      url: "https://example.test/mlf-jqka",
    },
  ], generatedAt, 10);

  assert.equal(items.length, 2);
  assert.equal(items[0].url, "https://example.test/mlf-cls");
  assert.deepEqual(items[0].relatedSources.map((item) => item.url), ["https://example.test/mlf-other"]);
  assert.equal(items[1].url, "https://example.test/mlf-jqka");
});

test("maps real US ETF closes into auditable A-share sector signals", async () => {
  const calls = [];
  const snapshot = await fetchUsEtfMapping(async (url) => {
    calls.push(url);
    const symbol = new URL(url).pathname.split("/").at(-1);
    const latest = symbol === "SMH" ? 108.5 : symbol === "XLP" ? 97.8 : 100.5;
    return new Response(JSON.stringify({
      chart: {
        result: [{
          timestamp: [Date.parse("2026-07-29T20:00:00Z") / 1000, Date.parse("2026-07-30T20:00:00Z") / 1000],
          indicators: {
            adjclose: [{ adjclose: [100, latest] }],
            quote: [{ close: [100, latest] }],
          },
        }],
        error: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, Date.UTC(2026, 6, 31, 0, 0));

  assert.equal(calls.length, 12);
  assert.equal(snapshot.items.length, 12);
  assert.equal(snapshot.items.find((item) => item.symbol === "SMH").direction, "bullish");
  assert.equal(snapshot.items.find((item) => item.symbol === "XLP").direction, "bearish");
  assert.equal(snapshot.items.find((item) => item.symbol === "XLU").direction, "neutral");
  assert.equal(snapshot.meta.sourceMode, "live");
  assert.match(snapshot.meta.methodology, /≥0.8%/);
});

test("limits US ETF requests to two concurrent calls and retries a transient failure", async () => {
  let active = 0;
  let maxActive = 0;
  const attempts = new Map();
  const snapshot = await fetchUsEtfMapping(async (url) => {
    const symbol = new URL(url).pathname.split("/").at(-1);
    attempts.set(symbol, (attempts.get(symbol) || 0) + 1);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    if (symbol === "SMH" && attempts.get(symbol) === 1) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response(JSON.stringify({
      chart: {
        result: [{
          timestamp: [Date.parse("2026-07-29T20:00:00Z") / 1000, Date.parse("2026-07-30T20:00:00Z") / 1000],
          indicators: {
            adjclose: [{ adjclose: [100, 101] }],
            quote: [{ close: [100, 101] }],
          },
        }],
        error: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, Date.UTC(2026, 6, 31, 0, 0), { retryDelays: [0, 0] });

  assert.ok(maxActive <= 2, `expected at most 2 concurrent requests, saw ${maxActive}`);
  assert.equal(attempts.get("SMH"), 2);
  assert.equal(snapshot.items.length, 12);
  assert.equal(snapshot.meta.sourceMode, "live");
});

test("keeps the last verified ETF row when one live symbol stays unavailable", async () => {
  const previousSnapshot = {
    meta: { generatedAt: "2026-07-30T00:00:00.000Z", marketDate: "2026-07-29", sourceMode: "live" },
    items: [{
      symbol: "XLP",
      usSector: "Consumer Staples",
      aShareSector: "食品饮料&农林牧渔",
      direction: "bearish",
      label: "看空下跌",
      pctChange: -1.2,
      close: 98.8,
      previousClose: 100,
      impactStrength: 40,
      marketDate: "2026-07-29",
      asOf: "2026-07-30T00:00:00.000Z",
    }],
  };
  const snapshot = await fetchUsEtfMapping(async (url) => {
    const symbol = new URL(url).pathname.split("/").at(-1);
    if (symbol === "XLP") return new Response("upstream unavailable", { status: 503 });
    return new Response(JSON.stringify({
      chart: {
        result: [{
          timestamp: [Date.parse("2026-07-29T20:00:00Z") / 1000, Date.parse("2026-07-30T20:00:00Z") / 1000],
          indicators: {
            adjclose: [{ adjclose: [100, 101] }],
            quote: [{ close: [100, 101] }],
          },
        }],
        error: null,
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  }, Date.UTC(2026, 6, 31, 0, 0), { previousSnapshot, retryDelays: [0, 0] });

  assert.equal(snapshot.items.length, 12);
  assert.equal(snapshot.meta.sourceMode, "partial");
  assert.equal(snapshot.meta.freshCount, 11);
  assert.equal(snapshot.meta.staleCount, 1);
  assert.deepEqual(snapshot.meta.failedSymbols, ["XLP"]);
  assert.equal(snapshot.items.find((item) => item.symbol === "XLP").freshness, "cached");
});

test("serves the last verified ETF snapshot when the live provider rate-limits", async () => {
  const STOCK_STATE = createMemoryKv();
  const fallback = {
    meta: { marketDate: "2026-07-30", sourceMode: "snapshot" },
    summary: { bullish: 2, neutral: 6, bearish: 4 },
    items: [{ symbol: "SMH", close: 106.88, previousClose: 100, pctChange: 6.88 }],
  };
  const snapshot = await getUsEtfMapSnapshot({
    STOCK_STATE,
    ASSETS: {
      fetch: async (request) => {
        assert.equal(new URL(request.url).pathname, "/data/us-etf-map.json");
        return new Response(JSON.stringify(fallback), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  }, new Request("https://example.test/api/us-etf-map"), async () => new Response("rate limited", { status: 429 }));

  assert.equal(snapshot.meta.sourceMode, "verified_snapshot");
  assert.equal(snapshot.meta.liveFetchStatus, "rate_limited");
  assert.equal(snapshot.items[0].symbol, "SMH");
  assert.ok(STOCK_STATE.values.has("us-etf-map:latest"));
});

test("does not replace an unavailable quant engine with static results", async () => {
  const response = await worker.fetch(new Request("https://example.test/api/quant/predict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stockCode: "300308" }),
  }), {
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.status, "configuration_required");
  assert.match(body.reason, /Tushare-compatible provider/);
});

test("runs a real built-in prediction from the frozen TOP50 snapshot", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("top50:latest", JSON.stringify({
    meta: { tradeDate: "2026-07-31", marketDataDate: "2026-07-30" },
    cycles: {
      "波段": {
        ranking: [{
          code: "300308",
          tsCode: "300308.SZ",
          name: "中际旭创",
          close: 100,
          score: 70,
          probabilityUp: 0.66,
          agentScores: { "陈江挺": 72, "养家": 68 },
          topAgents: ["陈江挺", "养家"],
          agentVotes: 7,
        }],
      },
    },
  }));
  const response = await worker.fetch(new Request("https://example.test/api/quant/predict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stockCode: "300308", cycle: "波段" }),
  }), {
    TUSHARE_TOKEN: "secret",
    STOCK_STATE,
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result.engine, "built-in-12-profile-factor-v1");
  assert.equal(body.result.rankingSource.provider, "Tushare daily + daily_basic + stock_basic");
  assert.equal(body.result.rankingSource.dataDate, "2026-07-30");
  assert.equal(body.result.referencePrice, 100);
  assert.equal(body.result.probabilityUp, 0.66);
  assert.equal(body.result.modelVersion, "agent-factor-v1");
});

test("batch stock lookup backfills names and industries without inventing unknown stocks", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("stock-basic:latest", JSON.stringify([
    { ts_code: "000001.SZ", symbol: "000001", name: "平安银行", industry: "银行", market: "主板", list_date: "19910403" },
    { ts_code: "600000.SH", symbol: "600000", name: "浦发银行", industry: "银行", market: "主板", list_date: "19991110" },
  ]));

  const response = await handleApi(new Request("https://example.test/api/stocks/lookup?codes=000001,600000,999999"), { STOCK_STATE }, new URL("https://example.test/api/stocks/lookup?codes=000001,600000,999999"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.items.map((item) => [item.code, item.name, item.industry]), [
    ["000001", "平安银行", "银行"],
    ["600000", "浦发银行", "银行"],
  ]);
  assert.equal(body.missing.includes("999999"), true);
});

test("stores the 09:25 auction as an explicitly labeled opening snapshot", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("top50:latest", JSON.stringify({
    cycles: { "波段": { ranking: [{ code: "300308", tsCode: "300308.SZ" }] } },
  }));
  const snapshot = await openingAuctionJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 24, 1, 25), async () => new Response(JSON.stringify({
    code: 0,
    data: {
      fields: ["ts_code", "trade_date", "vol", "price", "amount", "pre_close", "turnover_rate", "volume_ratio", "float_share"],
      items: [["300308.SZ", "20260824", 1200, 101, 121200, 100, 0.2, 1.4, 100000]],
    },
  }), { status: 200 }));

  assert.equal(snapshot.meta.session, "opening_auction");
  assert.match(snapshot.meta.disclaimer, /不代表盘中实时价格/);
  assert.equal(snapshot.quotes[0].pct, 1);
  assert.ok(STOCK_STATE.values.has("market:latest"));
});

test("treats an empty 09:25 auction response as delayed without replacing the last snapshot", async () => {
  const STOCK_STATE = createMemoryKv();
  const previous = {
    meta: { tradeDate: "2026-08-23", generatedAt: "2026-08-23T01:25:00.000Z" },
    quotes: [{ code: "300308", price: 100 }],
  };
  STOCK_STATE.values.set("opening-auction:latest", JSON.stringify(previous));
  STOCK_STATE.values.set("top50:latest", JSON.stringify({
    cycles: { "波段": { ranking: [{ code: "300308", tsCode: "300308.SZ" }] } },
  }));

  const result = await openingAuctionJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 24, 1, 25), async () => new Response(JSON.stringify({
    code: 0,
    data: { fields: ["ts_code", "trade_date"], items: [] },
  }), { status: 200 }));

  assert.equal(result.status, "pending");
  assert.equal(result.meta.retryAt, "09:33");
  assert.equal(result.retainedSnapshot, true);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("opening-auction:latest")), previous);
});

test("persists anonymous device alert preferences without requiring an account", async () => {
  const STOCK_STATE = createMemoryKv();
  const response = await worker.fetch(new Request("https://example.test/api/preferences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "device-123",
      watchlist: [{
        code: "300308",
        name: "中际旭创",
        triggerPrice: 188,
        riskPrice: 176.5,
        actions: { price: true, risk: true, preMarket: true },
      }],
    }),
  }), {
    STOCK_STATE,
    ASSETS: { fetch: async () => new Response("missing", { status: 404 }) },
  });

  assert.equal(response.status, 200);
  const stored = JSON.parse(STOCK_STATE.values.get("subscription:device-123"));
  assert.equal(stored.watchlist[0].triggerPrice, 188);
  assert.equal(stored.watchlist[0].actions.risk, true);
});

test("builds four real-data cycle rankings and immutable prediction records", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    ts_code: `${String(600000 + index).padStart(6, "0")}.SH`,
    trade_date: "20260729",
    name: `测试股票${index + 1}`,
    open: 10 + index,
    high: 10.8 + index,
    low: 9.7 + index,
    close: 10.5 + index,
    pct_chg: (index % 12) - 3,
    amount: 100000 + index * 10000,
    turnover_rate: 0.8 + index * 0.09,
    volume_ratio: 0.7 + index * 0.03,
    pe_ttm: 12 + index,
    pb: 1.1 + index * 0.04,
    total_mv: 1000000 + index * 50000,
  }));
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`);
  const result = buildTop50Snapshot(rows, "2026-07-30", futureDates, "2026-07-30T07:35:00.000Z");

  assert.deepEqual(Object.keys(result.snapshot.cycles), ["超短", "短线", "波段", "中长线"]);
  assert.equal(result.snapshot.meta.sourceMode, "live");
  assert.equal(result.snapshot.meta.marketDataDate, "2026-07-29");
  assert.equal(result.snapshot.cycles["短线"].ranking.length, 50);
  assert.equal(result.ledger.forecasts.length, 800);
  assert.ok(result.ledger.forecasts.every((item) => item.status === "pending"));
});

test("freezes auditable prediction identity and evidence", () => {
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  const result = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00.000Z");
  const forecast = result.ledger.forecasts[0];

  assert.equal(forecast.predictionId, forecast.id);
  assert.ok(forecast.snapshotId);
  assert.equal(forecast.dataCutoff, "2026-08-27T07:35:00.000Z");
  assert.deepEqual(forecast.lifecycle, { status: "pending", revision: 1 });
  assert.equal(forecast.evidenceCompleteness, "complete");
  assert.ok(forecast.dataLineage.marketProvider);
});

test("TOP50 ranking carries immutable selection evidence", () => {
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  const { snapshot } = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00.000Z");
  const item = snapshot.cycles["超短"].ranking[0];

  assert.ok(item.selectionEvidence.factorBreakdown);
  assert.ok(item.selectionEvidence.supportingAgents.length);
  assert.ok(item.selectionEvidence.trigger);
  assert.ok(item.selectionEvidence.invalidation);
  assert.equal(item.selectionEvidence.dataCutoff, snapshot.meta.generatedAt);
});

test("marks legacy evidence partial without inventing missing facts", () => {
  const migrated = migrateLegacyPrediction({ id: "old-1", code: "600000", status: "pending" }, { tradeDate: "2026-08-20" });

  assert.equal(migrated.predictionId, "legacy:old-1");
  assert.equal(migrated.evidenceCompleteness, "partial");
  assert.equal(migrated.teacherVersions, null);
  assert.equal(migrated.marketRegime, null);
  assert.equal(migrated.dataLineage, null);

  const frozen = migrateLegacyPrediction({ id: "old-2", snapshotId: "legacy-snapshot", dataCutoff: "2026-08-20T07:35:00.000Z" }, {});
  assert.equal(frozen.snapshotId, "legacy-snapshot");
  assert.equal(frozen.dataCutoff, "2026-08-20T07:35:00.000Z");
  assert.equal(frozen.teacherVersions, null);
});

test("uses D1 insert-if-absent semantics for immutable migration records", async () => {
  assert.equal(typeof workerModule.writeStateIfAbsent, "function");
  const storage = createMemoryD1();

  assert.equal(await workerModule.writeStateIfAbsent({ DB: storage.DB }, "prediction:legacy:old-1", { predictionId: "legacy:old-1", status: "pending" }), true);
  assert.equal(await workerModule.writeStateIfAbsent({ DB: storage.DB }, "prediction:legacy:old-1", { predictionId: "legacy:old-1", status: "evaluated" }), false);
  assert.deepEqual(JSON.parse(storage.values.get("prediction:legacy:old-1")), { predictionId: "legacy:old-1", status: "pending" });
  assert.ok(storage.statements.some((item) => item.sql.includes("ON CONFLICT(key) DO NOTHING")));
});

test("migrates legacy prediction evidence once and preserves existing singleton records", async () => {
  const STOCK_STATE = createMemoryKv();
  const url = new URL("https://example.test/api/admin/migrations/prediction-evidence");
  const env = { STOCK_STATE, ADMIN_API_TOKEN: "admin-token" };
  STOCK_STATE.values.set("predictions:2026-08-20", JSON.stringify({
    tradeDate: "2026-08-20",
    forecasts: [{ id: "old-1", code: "600000", status: "pending", maturityTradeDate: "2026-08-25" }],
  }));

  const unauthorized = await handleApi(new Request(url, { method: "POST" }), env, url);
  assert.ok(unauthorized, "migration endpoint must return a response");
  assert.equal(unauthorized.status, 401);

  const request = () => new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer admin-token" },
  });
  const first = await handleApi(request(), env, url);
  const firstBody = await first.json();
  const saved = STOCK_STATE.values.get("prediction:legacy:old-1");

  assert.deepEqual({ migrated: firstBody.migrated, skipped: firstBody.skipped, failed: firstBody.failed }, { migrated: 1, skipped: 0, failed: 0 });
  assert.equal(JSON.parse(saved).tradeDate, "2026-08-20");
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("prediction-due:2026-08-25")), ["legacy:old-1"]);

  STOCK_STATE.values.set("predictions:2026-08-20", JSON.stringify({
    tradeDate: "2026-08-20",
    forecasts: [{ id: "old-1", code: "600000", name: "would overwrite", status: "pending", maturityTradeDate: "2026-08-25" }],
  }));
  const second = await handleApi(request(), env, url);
  const secondBody = await second.json();

  assert.deepEqual({ migrated: secondBody.migrated, skipped: secondBody.skipped, failed: secondBody.failed }, { migrated: 0, skipped: 1, failed: 0 });
  assert.equal(STOCK_STATE.values.get("prediction:legacy:old-1"), saved);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("prediction-due:2026-08-25")), ["legacy:old-1"]);
});

test("limits a legacy prediction evidence migration batch to 500 records", async () => {
  const STOCK_STATE = createMemoryKv();
  const url = new URL("https://example.test/api/admin/migrations/prediction-evidence");
  STOCK_STATE.values.set("predictions:2026-08-21", JSON.stringify({
    tradeDate: "2026-08-21",
    forecasts: Array.from({ length: 501 }, (_, index) => ({ id: `old-${index + 1}`, code: `60${String(index).padStart(4, "0")}`, status: "pending" })),
  }));

  const response = await handleApi(new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer admin-token" },
  }), { STOCK_STATE, ADMIN_API_TOKEN: "admin-token" }, url);

  assert.ok(response, "migration endpoint must return a response");
  const body = await response.json();
  assert.deepEqual({ migrated: body.migrated, skipped: body.skipped, failed: body.failed }, { migrated: 500, skipped: 0, failed: 0 });
  assert.equal(body.hasMore, true);
  assert.equal(typeof body.nextCursor, "string");
  assert.ok(STOCK_STATE.values.has("prediction:legacy:old-500"));
  assert.equal(STOCK_STATE.values.has("prediction:legacy:old-501"), false);

  const nextResponse = await handleApi(new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
    body: JSON.stringify({ cursor: body.nextCursor }),
  }), { STOCK_STATE, ADMIN_API_TOKEN: "admin-token" }, url);
  const nextBody = await nextResponse.json();

  assert.deepEqual({ migrated: nextBody.migrated, skipped: nextBody.skipped, failed: nextBody.failed }, { migrated: 1, skipped: 0, failed: 0 });
  assert.equal(nextBody.hasMore, false);
  assert.equal(nextBody.nextCursor, null);
  assert.ok(STOCK_STATE.values.has("prediction:legacy:old-501"));
});

test("follows KV list cursors until a later legacy ledger is migrated", async () => {
  const STOCK_STATE = createPagedMemoryKv({
    first: { keys: [{ name: "prediction:legacy:already-migrated" }], cursor: "second" },
    second: { keys: [{ name: "predictions:2026-08-22" }] },
  });
  const url = new URL("https://example.test/api/admin/migrations/prediction-evidence");
  STOCK_STATE.values.set("predictions:2026-08-22", JSON.stringify({
    tradeDate: "2026-08-22",
    forecasts: [{ id: "page-two", code: "600000", status: "pending" }],
  }));

  const response = await handleApi(new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer admin-token" },
  }), { STOCK_STATE, ADMIN_API_TOKEN: "admin-token" }, url);
  const body = await response.json();

  assert.equal(body.migrated, 1);
  assert.deepEqual(STOCK_STATE.listCalls, [null, "second"]);
  assert.ok(STOCK_STATE.values.has("prediction:legacy:page-two"));
});

test("uses unique snapshot-scoped prediction IDs for identical builds", async () => {
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  const generatedAt = "2026-08-27T07:35:00.000Z";
  const first = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, generatedAt);
  const second = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, generatedAt);
  const firstForecast = first.ledger.forecasts[0];
  const secondForecast = second.ledger.forecasts[0];
  const STOCK_STATE = createMemoryKv();

  assert.notEqual(first.snapshot.meta.snapshotId, second.snapshot.meta.snapshotId);
  assert.equal(firstForecast.snapshotId, first.snapshot.meta.snapshotId);
  assert.equal(first.snapshot.cycles["超短"].snapshotId, first.snapshot.meta.snapshotId);
  assert.ok(first.snapshot.cycles["超短"].cycleSnapshotId);
  assert.notEqual(firstForecast.predictionId, secondForecast.predictionId);
  assert.ok(firstForecast.predictionId.includes(first.snapshot.meta.snapshotId));

  await Promise.all(first.ledger.forecasts.map((forecast) => STOCK_STATE.put(`prediction:${forecast.predictionId}`, JSON.stringify(forecast))));
  const firstContent = STOCK_STATE.values.get(`prediction:${firstForecast.predictionId}`);
  await Promise.all(second.ledger.forecasts.map((forecast) => STOCK_STATE.put(`prediction:${forecast.predictionId}`, JSON.stringify(forecast))));

  assert.equal(STOCK_STATE.values.size, first.ledger.forecasts.length + second.ledger.forecasts.length);
  assert.equal(STOCK_STATE.values.get(`prediction:${firstForecast.predictionId}`), firstContent);
  assert.ok(STOCK_STATE.values.has(`prediction:${secondForecast.predictionId}`));
});

test("prediction event appends one immutable audit entry per deterministic event id", async () => {
  const STOCK_STATE = createMemoryKv();
  const predictionId = "20260827:波段:600001.SH:1d";
  const frozenPrediction = { predictionId, status: "pending", lifecycle: { status: "pending", revision: 1 } };
  STOCK_STATE.values.set(`prediction:${predictionId}`, JSON.stringify(frozenPrediction));

  const event = {
    eventId: `evaluation:${predictionId}:2026-08-28`,
    type: "evaluation_recorded",
    occurredAt: "2026-08-28T07:10:00.000Z",
    reason: "maturity close available",
    patch: { actualPrice: 11, status: "evaluated" },
  };
  await appendPredictionEvent({ STOCK_STATE }, predictionId, event);
  const events = await appendPredictionEvent({ STOCK_STATE }, predictionId, event);

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    eventId: `evaluation:${predictionId}:2026-08-28`,
    type: "evaluation_recorded",
    occurredAt: "2026-08-28T07:10:00.000Z",
    reason: "maturity close available",
    patch: { actualPrice: 11, status: "evaluated" },
  });
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get(`prediction-events:${predictionId}`)), events);
  assert.equal(STOCK_STATE.values.get(`prediction:${predictionId}`), JSON.stringify(frozenPrediction));
});

test("writes frozen prediction records with production-teacher lineage", async () => {
  const { STOCK_STATE, fetchImpl } = top50GenerationFixture();

  await generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" }, Date.UTC(2026, 7, 26, 23, 35), fetchImpl);

  const ledger = JSON.parse(STOCK_STATE.values.get("predictions:2026-08-27"));
  const forecast = ledger.forecasts[0];
  assert.equal(forecast.marketRegime, "bull");
  assert.equal(Object.keys(forecast.teacherVersions).length, 12);
  assert.equal(forecast.teacherVersions["陈江挺"], "knowledge-1");
  assert.equal(JSON.parse(STOCK_STATE.values.get(`prediction:${forecast.predictionId}`)).predictionId, forecast.predictionId);
  assert.ok(JSON.parse(STOCK_STATE.values.get(`prediction-due:${forecast.maturityTradeDate}`)).includes(forecast.predictionId));
});

test("persists each TOP50 snapshot history with a three-year TTL", async () => {
  const { STOCK_STATE, fetchImpl } = top50GenerationFixture();

  await generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" }, Date.UTC(2026, 7, 26, 23, 35), fetchImpl);

  const latest = JSON.parse(STOCK_STATE.values.get("top50:latest"));
  const historyKey = `top50:snapshot:${latest.meta.snapshotId}`;
  const historyPut = STOCK_STATE.puts.find((item) => item.key === historyKey);

  assert.ok(STOCK_STATE.values.has(historyKey));
  assert.equal(JSON.parse(STOCK_STATE.values.get(historyKey)).meta.snapshotId, latest.meta.snapshotId);
  assert.equal(historyPut?.options?.expirationTtl, 3 * 366 * 86400);
});

test("preserves frozen prediction records on a same-day TOP50 rerun", async () => {
  const { STOCK_STATE, fetchImpl } = top50GenerationFixture();
  const firstRun = Date.UTC(2026, 7, 26, 23, 35);
  const rerun = Date.UTC(2026, 7, 26, 23, 36);

  await generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" }, firstRun, fetchImpl);
  const firstLedger = JSON.parse(STOCK_STATE.values.get("predictions:2026-08-27"));
  const predictionId = firstLedger.forecasts[0].predictionId;
  const frozenRecord = STOCK_STATE.values.get(`prediction:${predictionId}`);

  await generateTop50Job({ STOCK_STATE, TUSHARE_PRIMARY_TOKEN: "secret" }, rerun, fetchImpl);

  assert.equal(STOCK_STATE.values.get(`prediction:${predictionId}`), frozenRecord);
  assert.equal(JSON.parse(STOCK_STATE.values.get("top50:latest")).meta.generatedAt, "2026-08-26T23:35:00.000Z");
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("predictions:2026-08-27")), firstLedger);
  assert.equal([...STOCK_STATE.values.keys()].filter((key) => key.startsWith("prediction:")).length, firstLedger.forecasts.length);
});

test("rejects newly listed, price-limit, illiquid, and risk-warning stocks before TOP50 scoring", () => {
  const base = {
    trade_date: "20260821", list_date: "20200101", close: 10, amount: 200000,
    pct_chg: 2, turnover_rate: 2, volume_ratio: 1.2, name: "正常股票",
  };
  const rows = [
    { ...base, ts_code: "600001.SH" },
    { ...base, ts_code: "600002.SH", list_date: "20260701", name: "新股" },
    { ...base, ts_code: "600003.SH", pct_chg: 9.8, name: "涨停股" },
    { ...base, ts_code: "600004.SH", amount: 50000, name: "低流动性" },
    { ...base, ts_code: "600005.SH", name: "ST风险" },
  ];
  const result = screenTradableUniverse(rows, "2026-08-21");

  assert.deepEqual(result.eligible.map((item) => item.ts_code), ["600001.SH"]);
  assert.equal(result.excluded.newlyListed, 1);
  assert.equal(result.excluded.priceLimit, 1);
  assert.equal(result.excluded.liquidity, 1);
  assert.equal(result.excluded.riskName, 1);
});

test("risk-filters legacy cached rankings until the next full TOP50 generation", () => {
  const snapshot = sanitizeTop50Snapshot({
    meta: { sourceMode: "live" },
    cycles: {
      "短线": { ranking: [
        { code: "920093", tsCode: "920093.BJ", name: "极端新股", pct: 61.6, score: 80, agentVotes: 8 },
        { code: "600001", tsCode: "600001.SH", name: "正常股票", pct: 2, score: 62, agentVotes: 6 },
      ] },
    },
  });

  assert.equal(snapshot.cycles["短线"].ranking.length, 1);
  assert.equal(snapshot.cycles["短线"].ranking[0].status, "等待确认");
  assert.equal(snapshot.meta.riskGate.requiresRegeneration, true);
});

test("labels Wall Street ETF news as global and preserves timestamp provenance", () => {
  const snapshot = normalizeNews([{
    title: "华尔街芯片杠杆ETF暴跌",
    description: "美股风险偏好转弱",
    publishedAt: "2026-08-24T08:00:00.000Z",
    timestampBasis: "source_updated_at",
    source: { name: "测试源" },
    url: "https://example.test/news",
  }], "2026-08-24T08:05:00.000Z", ["测试源"]);

  assert.equal(snapshot.items[0].market, "美股/全球");
  assert.equal(snapshot.items[0].timestampBasis, "source_updated_at");
});

test("keeps domestic ETF company news in the A-share channel", () => {
  const snapshot = normalizeNews([{
    title: "公司回应创业板ETF持仓变化",
    description: "投资者通过互动平台询问A股业务进展",
    publishedAt: "2026-08-26T06:00:00.000Z",
    sourceId: "cninfo-latest",
    source: { name: "巨潮资讯" },
    url: "https://example.test/cninfo",
  }], "2026-08-26T06:05:00.000Z", ["晴红50+"]);

  assert.equal(snapshot.items[0].market, "A股/中国");
  assert.equal(snapshot.items[0].classificationReason, "domestic_source");
});

test("reclassifies legacy cached domestic news instead of preserving a stale global label", () => {
  const snapshot = sanitizeNewsSnapshot({
    meta: { generatedAt: "2026-08-26T07:00:00.000Z" },
    items: [{
      id: "legacy-1",
      title: "DeepSeek前七月营收增长，推进新一轮融资",
      summary: "营收和融资均以人民币计价。",
      sourceId: "jqka-flash",
      source: "同花顺",
      market: "美股/全球",
    }],
  });

  assert.equal(snapshot.items[0].market, "A股/中国");
  assert.equal(snapshot.items[0].classificationReason, "domestic_source");
});

test("deduplicates and sanitizes provider failures before risk-center display", () => {
  const alerts = buildUserFacingProviderAlerts([
    { id: "new", type: "market_source_degraded", level: "critical", title: "盘中行情源降级", body: "rt_min HTTP 504 https://secret.example.test", createdAt: "2026-08-26T06:10:00Z" },
    { id: "old", type: "market_source_degraded", level: "critical", title: "盘中行情源降级", body: "token expired", createdAt: "2026-08-26T05:10:00Z" },
    { id: "job-new", type: "job_failed", level: "critical", title: "global-news 定时任务失败", body: "HTTP 500", createdAt: "2026-08-26T06:05:00Z" },
    { id: "job-old", type: "job_failed", level: "critical", title: "top50 定时任务失败", body: "HTTP 504", createdAt: "2026-08-26T05:05:00Z" },
  ]);

  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].id, "new");
  assert.equal(alerts[0].title, "盘中行情服务暂时降级");
  assert.doesNotMatch(alerts[0].detail, /rt_min|HTTP|https?:\/\/|token/i);
  assert.equal(alerts.filter((item) => item.title === "后台数据更新未完成").length, 1);
});

test("keeps entertainment content out of the investment-news feed", () => {
  const snapshot = normalizeNews([
    {
      title: "韩庚自曝酒量引发网友热议",
      description: "综艺节目片段登上热搜",
      sourceId: "sohu",
      source: { name: "搜狐财经" },
      publishedAt: "2026-08-27T01:00:00.000Z",
      url: "https://example.test/entertainment",
    },
    {
      title: "美联储官员释放降息信号，美股期指走高",
      description: "美元指数和美债收益率同步波动",
      sourceId: "mktnews",
      source: { name: "MKTNews" },
      publishedAt: "2026-08-27T01:01:00.000Z",
      url: "https://example.test/fed",
    },
    {
      title: "苹果秋季发布会定档9月10日凌晨",
      description: "供应链与消费电子板块关注新品节奏",
      sourceId: "cls",
      source: { name: "财联社" },
      publishedAt: "2026-08-27T01:02:00.000Z",
      url: "https://example.test/apple",
    },
  ], "2026-08-27T01:05:00.000Z", ["晴红50+"]);

  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items[0].market, "美股/全球");
  assert.equal(snapshot.items[1].market, "美股/全球");
  assert.equal(snapshot.meta.itemCount, 2);
});

test("compacts repeated provider failures before returning the notification feed", () => {
  const items = compactNotifications([
    { id: "n3", type: "job_failed", level: "critical", title: "us-etf-map 定时任务失败", body: "HTTP 504 token=secret", createdAt: "2026-08-27T01:30:00.000Z" },
    { id: "n2", type: "job_failed", level: "critical", title: "us-etf-map 定时任务失败", body: "HTTP 504 token=secret", createdAt: "2026-08-27T01:20:00.000Z" },
    { id: "n2b", type: "job_failed", level: "critical", title: "美股ETF映射刷新失败", body: "HTTP 504 token=secret", createdAt: "2026-08-27T01:19:00.000Z" },
    { id: "n2c", type: "job_failed", level: "critical", title: "us-etf-map 定时任务失败", body: "HTTP 504 token=secret", createdAt: "2026-08-26T23:59:00.000Z" },
    { id: "n1", type: "price", level: "important", title: "招商银行 价格触发", body: "最新价39.54", createdAt: "2026-08-27T01:10:00.000Z" },
  ]);

  assert.equal(items.length, 2);
  assert.equal(items[0].repeatCount, 4);
  assert.equal(items[0].title, "美股ETF映射更新未完成");
  assert.doesNotMatch(items[0].body, /HTTP|token/i);
  assert.equal(items[1].title, "招商银行 价格触发");
});

test("prefers the current-day auction snapshot over a stale intraday snapshot", () => {
  const selected = selectMarketSnapshot(
    {
      meta: { generatedAt: "2026-08-27T00:00:00.000Z", tradeDate: "2026-08-27", provider: "ProMax rt_k" },
      quotes: [{ code: "600036", price: 39.5 }],
    },
    {
      meta: { generatedAt: "2026-08-27T01:30:00.000Z", tradeDate: "2026-08-27", provider: "Tushare stk_auction", session: "opening_auction", marketTime: "09:25" },
      quotes: [{ code: "600036", price: 39.54 }],
    },
    { session: "morning" },
    { status: "degraded", failedAt: "2026-08-27T01:31:00.000Z" },
    Date.UTC(2026, 7, 27, 2, 0),
  );

  assert.equal(selected.meta.provider, "Tushare stk_auction");
  assert.equal(selected.meta.session, "opening_auction");
  assert.equal(selected.quotes[0].price, 39.54);
});

function makeEvaluatedForecasts(count, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `evaluated-${index}`,
    status: "evaluated",
    evidenceCompleteness: "complete",
    horizon: "5d",
    cycle: "波段",
    code: String(600000 + index),
    name: `样本${index}`,
    industry: "半导体",
    marketRegime: "bull",
    predictedDirection: "up",
    probabilityUp: 0.8,
    actualDirection: index % 2 === 0 ? "up" : "down",
    hit: index % 2 === 0,
    brierScore: index % 2 === 0 ? 0.04 : 0.64,
    actualReturn: index % 2 === 0 ? 0.03 : -0.02,
    maximumAdverseExcursion: -(index + 1) / 100,
    topAgents: ["谭琦"],
    maturityTradeDate: "2026-07-30",
    evaluatedAt: `2026-07-30T07:00:${String(index).padStart(2, "0")}Z`,
    ...overrides,
  }));
}

test("withholds grouped metrics below thirty complete evaluated samples", () => {
  const accuracy = calculateAccuracy([
    ...makeEvaluatedForecasts(9),
    ...makeEvaluatedForecasts(1, { id: "partial", evidenceCompleteness: "partial" }),
    ...makeEvaluatedForecasts(1, { id: "missing", evidenceCompleteness: undefined }),
  ]);

  assert.equal(accuracy.status, "ready");
  assert.deepEqual(accuracy.overall, {
    sampleCount: 9,
    sampleStatus: "insufficient",
    pairedSampleCount: 0,
    benchmarkAverageReturn: null,
    averageExcessReturn: null,
    hitRate: null,
    brierScore: null,
    averageReturn: null,
    maximumAdverseExcursion: null,
  });
  assert.equal(accuracy.horizons["5d"].sampleStatus, "insufficient");
  assert.equal(accuracy.cycles["波段"].hitRate, null);
  assert.equal(accuracy.directions.up.brierScore, null);
  assert.equal(accuracy.industries["半导体"].averageReturn, null);
  assert.equal(accuracy.marketRegimes.bull.maximumAdverseExcursion, null);
  assert.equal(accuracy.byAgent["谭琦"].sampleCount, 9);
});

test("publishes calibrated metrics and stratified groups at thirty complete samples", () => {
  assert.equal(typeof workerModule.summarizeAccuracy, "function");
  const items = makeEvaluatedForecasts(30);
  const accuracy = calculateAccuracy(items);

  assert.deepEqual(accuracy.overall, {
    sampleCount: 30,
    sampleStatus: "sufficient",
    pairedSampleCount: 0,
    benchmarkAverageReturn: null,
    averageExcessReturn: null,
    hitRate: 50,
    brierScore: 0.34,
    averageReturn: 0.005,
    maximumAdverseExcursion: -0.3,
  });
  assert.equal(accuracy.horizons["5d"].sampleStatus, "sufficient");
  assert.equal(accuracy.cycles["波段"].hitRate, 50);
  assert.equal(accuracy.directions.up.brierScore, 0.34);
  assert.equal(accuracy.industries["半导体"].sampleCount, 30);
  assert.equal(accuracy.marketRegimes.bull.hitRate, 50);
  assert.equal(accuracy.byAgent["谭琦"].averageReturn, 0.005);
  assert.equal(workerModule.summarizeAccuracy(items.slice(0, 2), 2).sampleStatus, "sufficient");
  assert.equal(accuracy.recentEvaluations.length, 20);
  assert.equal(accuracy.recentEvaluations[0].code, "600029");
});

test("accuracy endpoint does not promote incomplete legacy evidence into primary metrics", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("accuracy:latest", JSON.stringify({
    status: "ready",
    overall: { sampleCount: 1, hitRate: 100, brierScore: 0.04, averageReturn: 0.03 },
    recentEvaluations: [{ id: "cached-f1", code: "000001", hit: true }],
  }));
  STOCK_STATE.values.set("predictions:2026-08-25", JSON.stringify({
    forecasts: [{ id: "f1", status: "evaluated", evidenceCompleteness: "partial", horizon: "1d", cycle: "超短", code: "000001", name: "平安银行", predictedDirection: "up", probabilityUp: 0.8, actualDirection: "up", actualReturn: 0.03, hit: true, brierScore: 0.04, maturityTradeDate: "2026-08-26", evaluatedAt: "2026-08-26T07:10:00Z" }],
  }));

  const response = await handleApi(new Request("https://example.test/api/accuracy"), { STOCK_STATE }, new URL("https://example.test/api/accuracy"));
  const body = await response.json();

  assert.equal(body.overall.sampleCount, 0);
  assert.equal(body.overall.sampleStatus, "insufficient");
  assert.equal(body.recentEvaluations.length, 0);
});

test("status endpoint does not advertise a legacy accuracy sample count", async () => {
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set("accuracy:latest", JSON.stringify({
    status: "ready",
    overall: { sampleCount: 200, hitRate: 55.6 },
  }));

  const response = await handleApi(new Request("https://example.test/api/status"), { STOCK_STATE }, new URL("https://example.test/api/status"));
  const body = await response.json();

  assert.equal(body.health.accuracy.sampleCount, 0);
});

test("accuracy cache miss returns collecting without scanning prediction singletons", async () => {
  const STOCK_STATE = createCountedMemoryKv();
  STOCK_STATE.values.set("prediction:f1", JSON.stringify(makeEvaluatedForecasts(1)[0]));

  const response = await handleApi(new Request("https://example.test/api/accuracy"), { STOCK_STATE }, new URL("https://example.test/api/accuracy"));
  const body = await response.json();

  assert.equal(body.status, "collecting");
  assert.equal(body.rebuildRequired, true);
  assert.equal(body.overall.sampleCount, 0);
  assert.equal(STOCK_STATE.operations.list, 0);
  assert.deepEqual(STOCK_STATE.operations.listPrefixes, []);
});

test("returns frozen prediction with append-only evaluation events", async () => {
  const kv = createMemoryKv();
  kv.values.set("prediction:p1", JSON.stringify({ predictionId: "p1", status: "pending" }));
  kv.values.set("prediction-events:p1", JSON.stringify([{ type: "evaluation", occurredAt: "2026-08-27T15:10:00Z" }]));
  const response = await handleApi(new Request("https://example.test/api/accuracy/evidence?predictionId=p1"), { STOCK_STATE: kv }, new URL("https://example.test/api/accuracy/evidence?predictionId=p1"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events.map((item) => item.type), ["evaluation"]);
});

test("keeps legacy-style prediction evidence ids working", async () => {
  const kv = createMemoryKv();
  const predictionId = "20260827:波段:600001.SH:1d";
  kv.values.set(`prediction:${predictionId}`, JSON.stringify({ predictionId, status: "pending" }));
  const url = new URL(`https://example.test/api/accuracy/evidence?predictionId=${encodeURIComponent(predictionId)}`);
  const response = await handleApi(new Request(url), { STOCK_STATE: kv }, url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).prediction.predictionId, predictionId);
});

test("resolves migrated legacy prediction ids with escaped characters", async () => {
  const kv = createMemoryKv();
  const predictionId = "legacy:a%2Fb%20c%3Fd";
  kv.values.set(`prediction:${predictionId}`, JSON.stringify({ predictionId, status: "pending" }));
  const url = new URL(`https://example.test/api/accuracy/evidence?predictionId=${encodeURIComponent(predictionId)}`);
  const response = await handleApi(new Request(url), { STOCK_STATE: kv }, url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).prediction.predictionId, predictionId);
});

test("does not fall back to another prediction when evidence ID is missing or unsafe", async () => {
  const kv = createMemoryKv();
  kv.values.set("prediction:p1", JSON.stringify({ predictionId: "p1", status: "pending" }));
  for (const predictionId of ["missing", "p1/other"]) {
    const url = new URL(`https://example.test/api/accuracy/evidence?predictionId=${encodeURIComponent(predictionId)}`);
    const response = await handleApi(new Request(url), { STOCK_STATE: kv }, url);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "prediction evidence not found" });
  }
});

test("rejects stale evidence responses once a newer prediction request is active", () => {
  const activeRequest = { token: 2, predictionId: "p2" };
  assert.equal(isCurrentEvidenceRequest(activeRequest, { token: 1, predictionId: "p1" }), false);
  assert.equal(isCurrentEvidenceRequest(activeRequest, { token: 2, predictionId: "p1" }), false);
  assert.equal(isCurrentEvidenceRequest(activeRequest, { token: 2, predictionId: "p2" }), true);
});

test("TOP50 evidence endpoint returns frozen selection evidence and events", async () => {
  const kv = createMemoryKv();
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  const { snapshot, ledger } = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00.000Z");
  const prediction = ledger.forecasts[0];
  const event = { type: "evaluation_recorded", occurredAt: "2026-08-28T07:10:00Z" };
  kv.values.set(`prediction:${prediction.predictionId}`, JSON.stringify(prediction));
  kv.values.set(`prediction-events:${prediction.predictionId}`, JSON.stringify([event]));
  kv.values.set(`top50:snapshot:${snapshot.meta.snapshotId}`, JSON.stringify(snapshot));

  const url = new URL(`https://example.test/api/top50/evidence?predictionId=${encodeURIComponent(prediction.predictionId)}`);
  const response = await handleApi(new Request(url), { STOCK_STATE: kv }, url);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.prediction.predictionId, prediction.predictionId);
  assert.equal(body.selectionEvidence.dataCutoff, snapshot.meta.generatedAt);
  assert.deepEqual(body.events, [event]);
});

test("TOP50 evidence endpoint returns 400 for invalid id and 404 for missing prediction", async () => {
  const kv = createMemoryKv();
  const futureDates = Array.from({ length: 65 }, (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`);
  const { snapshot, ledger } = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00.000Z");
  const existing = ledger.forecasts[0];
  const sameStockMissing = ledger.forecasts[1];
  kv.values.set(`prediction:${existing.predictionId}`, JSON.stringify(existing));
  kv.values.set(`top50:snapshot:${snapshot.meta.snapshotId}`, JSON.stringify(snapshot));

  const invalidUrl = new URL("https://example.test/api/top50/evidence?predictionId=p1/other");
  const invalidResponse = await handleApi(new Request(invalidUrl), { STOCK_STATE: kv }, invalidUrl);
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), { error: "invalid predictionId" });

  const missingUrl = new URL(`https://example.test/api/top50/evidence?predictionId=${encodeURIComponent(sameStockMissing.predictionId)}`);
  const missingResponse = await handleApi(new Request(missingUrl), { STOCK_STATE: kv }, missingUrl);
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "prediction evidence not found" });
});

test("retries a due prediction after the first daily quote response is empty", async () => {
  const STOCK_STATE = createMemoryKv();
  const prediction = makePendingPredictionRecord();
  STOCK_STATE.values.set(`prediction:${prediction.predictionId}`, JSON.stringify(prediction));
  STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify([prediction.predictionId]));
  STOCK_STATE.values.set("predictions:2026-08-24", JSON.stringify({
    tradeDate: "2026-08-24",
    forecasts: [prediction],
  }));

  let requestCount = 0;
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.api_name, "daily");
    assert.equal(request.params.trade_date, "20260825");
    assert.equal(request.fields, "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount");
    requestCount += 1;
    const rows = requestCount === 1 ? [] : [["600001.SH", "20260825", 10, 11.5, 9, 11]];
    return new Response(JSON.stringify({
      code: 0,
      data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close"], items: rows },
    }), { status: 200 });
  };

  const first = await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 10), fetchImpl);

  assert.equal(first.evaluation.newlyEvaluated, 0);
  assert.equal(first.overall.sampleCount, 0);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("evaluation:pendingMissingClose")), {
    "2026-08-25": [prediction.predictionId],
  });

  const second = await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 11), fetchImpl);

  assert.equal(second.evaluation.newlyEvaluated, 1);
  assert.equal(second.overall.sampleCount, 1);
  assert.equal(JSON.parse(STOCK_STATE.values.get(`prediction-events:${prediction.predictionId}`)).length, 1);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("evaluation:pendingMissingClose")), {});
});

test("builds industry rankings only from the live TOP50 snapshot and linked news", () => {
  const snapshot = buildIndustrySnapshot({
    meta: { sourceMode: "live", marketDataDate: "2026-08-25", generatedAt: "2026-08-25T23:35:00Z" },
    cycles: { "波段": { ranking: [
      { code: "600001", name: "芯片甲", industry: "半导体", pct: 2, score: 70, probabilityUp: 0.66, risk: "低", peTtm: 30 },
      { code: "600002", name: "芯片乙", industry: "半导体", pct: -1, score: 60, probabilityUp: 0.56, risk: "中", peTtm: 45 },
      { code: "600003", name: "银行甲", industry: "银行", pct: 0.5, score: 58, probabilityUp: 0.53, risk: "高", peTtm: 6 },
    ] } },
  }, {
    meta: { sourceMode: "live", generatedAt: "2026-08-26T05:00:00Z" },
    items: [
      { id: "n1", title: "芯片设备订单增长", source: "财联社", time: "12:30", url: "https://example.test/chip", publishedAt: "2026-08-26T04:30:00Z" },
      { id: "n2", title: "无关新闻", source: "财联社", time: "12:00", url: "https://example.test/other", publishedAt: "2026-08-26T04:00:00Z" },
    ],
  }, Date.UTC(2026, 7, 26, 5, 10));

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.meta.sourceMode, "derived_from_live");
  assert.equal(snapshot.industries[0].name, "半导体");
  assert.equal(snapshot.industries[0].stockCount, 2);
  assert.equal(snapshot.industries[0].news[0].url, "https://example.test/chip");
  assert.equal(snapshot.catalysts.length, 1);
});

test("builds stock risk cards without operational provider alerts", () => {
  const snapshot = buildRiskSnapshot({
    meta: { sourceMode: "live", marketDataDate: "2026-08-25", generatedAt: "2026-08-25T23:35:00Z" },
    cycles: { "波段": { ranking: [
      { code: "600001", name: "样本甲", score: 70, probabilityUp: 0.66, risk: "低", pct: 2 },
      { code: "600002", name: "样本乙", score: 50, probabilityUp: 0.5, risk: "高", pct: -2 },
    ] } },
  }, {
    meta: { sourceMode: "live", provider: "Tushare rt_min", generatedAt: "2026-08-26T05:09:00Z", tradeDate: "2026-08-26" },
    quotes: [
      { code: "600001", price: 10.2, open: 10 },
      { code: "600002", price: 9.8, open: 10 },
    ],
  }, calculateAccuracy([]), Date.UTC(2026, 7, 26, 5, 10));

  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.meta.sourceMode, "derived_from_live");
  assert.equal(snapshot.gates.length, 4);
  assert.equal(snapshot.gates.find((item) => item.id === "top50").score, 50);
  assert.match(snapshot.gates.find((item) => item.id === "market").evidence, /持仓行情/);
  assert.doesNotMatch(JSON.stringify(snapshot.alerts), /provider|数据源|后台任务/);
  assert.ok(snapshot.alerts.some((item) => item.stockCode === "600002"));
});

function makePendingPredictionRecord(overrides = {}) {
  return {
    id: "f1",
    predictionId: "f1",
    snapshotId: "snapshot-1",
    tradeDate: "2026-08-24",
    status: "pending",
    lifecycle: { status: "pending", revision: 1 },
    evidenceCompleteness: "complete",
    horizon: "1d",
    cycle: "波段",
    code: "600001",
    tsCode: "600001.SH",
    name: "样本甲",
    industry: "银行",
    marketRegime: "bull",
    maturityTradeDate: "2026-08-25",
    referencePrice: 10,
    probabilityUp: 0.6,
    predictedDirection: "up",
    topAgents: ["谭琦"],
    ...overrides,
  };
}

function maturityQuoteFetch(rows) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.api_name, "daily");
    assert.equal(request.params.trade_date, "20260825");
    assert.equal(request.fields, "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount");
    return new Response(JSON.stringify({
      code: 0,
      data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close"], items: rows },
    }), { status: 200 });
  };
}

function seedDuePredictions(STOCK_STATE, total, dueCount = total) {
  const due = [];
  const future = [];
  const rows = [];
  for (let index = 0; index < total; index += 1) {
    const code = String(600000 + index).padStart(6, "0");
    const maturityTradeDate = index < dueCount ? "2026-08-25" : "2026-09-01";
    const prediction = makePendingPredictionRecord({
      id: `batch-${index}`,
      predictionId: `batch-${index}`,
      code,
      tsCode: `${code}.SH`,
      maturityTradeDate,
    });
    STOCK_STATE.values.set(`prediction:${prediction.predictionId}`, JSON.stringify(prediction));
    (index < dueCount ? due : future).push(prediction.predictionId);
    if (index < dueCount) rows.push([prediction.tsCode, "20260825", 10, 11.5, 9, 11]);
  }
  if (due.length) STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify(due));
  if (future.length) STOCK_STATE.values.set("prediction-due:2026-09-01", JSON.stringify(future));
  return { due, future, rows };
}

test("processes only two hundred indexed due predictions under nine hundred KV operations", async () => {
  const STOCK_STATE = createCountedMemoryKv();
  const fixture = seedDuePredictions(STOCK_STATE, 800, 200);

  const accuracy = await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 10), maturityQuoteFetch(fixture.rows));

  assert.equal(accuracy.overall.sampleCount, 200);
  assert.equal(accuracy.evaluation.newlyEvaluated, 200);
  assert.equal(accuracy.hasMore, false);
  assert.equal(STOCK_STATE.values.has(`prediction-events:${fixture.future[0]}`), false);
  assert.ok(STOCK_STATE.operations.total < 900, `expected <900 KV ops, received ${STOCK_STATE.operations.total}`);
  assert.deepEqual(STOCK_STATE.operations.listPrefixes, ["prediction-due:"]);
});

test("continues four hundred due predictions in stable batches without duplicate events", async () => {
  const STOCK_STATE = createMemoryKv();
  const fixture = seedDuePredictions(STOCK_STATE, 400);
  const env = {
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  };
  const fetchImpl = maturityQuoteFetch(fixture.rows);

  const first = await evaluatePredictionsJob(env, Date.UTC(2026, 7, 26, 7, 10), fetchImpl);
  assert.equal(first.overall.sampleCount, 300);
  assert.equal(first.evaluation.newlyEvaluated, 300);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.nextCursor, "string");

  const second = await evaluatePredictionsJob(env, Date.UTC(2026, 7, 26, 7, 11), fetchImpl);
  assert.equal(second.overall.sampleCount, 400);
  assert.equal(second.evaluation.newlyEvaluated, 100);
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(JSON.parse(STOCK_STATE.values.get("evaluation:cursor")), { dueDate: "2026-08-25", offset: 400 });
  assert.ok(fixture.due.every((predictionId) => JSON.parse(STOCK_STATE.values.get(`prediction-events:${predictionId}`)).length === 1));
});

test("evaluates every frozen prediction after a same-day snapshot rerun", async () => {
  const first = makePendingPredictionRecord({ id: "snapshot-1:f1", predictionId: "snapshot-1:f1", snapshotId: "snapshot-1" });
  const second = makePendingPredictionRecord({ id: "snapshot-2:f1", predictionId: "snapshot-2:f1", snapshotId: "snapshot-2", code: "600002", tsCode: "600002.SH", referencePrice: 20 });
  const STOCK_STATE = createMemoryKv();
  STOCK_STATE.values.set(`prediction:${first.predictionId}`, JSON.stringify(first));
  STOCK_STATE.values.set(`prediction:${second.predictionId}`, JSON.stringify(second));
  STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify([first.predictionId, second.predictionId]));
  STOCK_STATE.values.set("predictions:2026-08-24", JSON.stringify({
    tradeDate: "2026-08-24",
    snapshotId: "snapshot-2",
    forecasts: [second],
  }));

  const accuracy = await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 10), maturityQuoteFetch([
    ["600001.SH", "20260825", 10, 11.5, 9, 11],
    ["600002.SH", "20260825", 20, 22, 18, 21],
  ]));

  assert.equal(accuracy.overall.sampleCount, 2);
  assert.equal(accuracy.evaluation.newlyEvaluated, 2);
  assert.equal(JSON.parse(STOCK_STATE.values.get(`prediction-events:${first.predictionId}`)).length, 1);
  assert.equal(JSON.parse(STOCK_STATE.values.get(`prediction-events:${second.predictionId}`)).length, 1);
  const ledger = JSON.parse(STOCK_STATE.values.get("predictions:2026-08-24"));
  assert.deepEqual(new Set(ledger.forecasts.map((item) => item.predictionId)), new Set([first.predictionId, second.predictionId]));
  assert.ok(ledger.forecasts.every((item) => item.status === "evaluated"));

  STOCK_STATE.values.delete("accuracy:latest");
  const response = await handleApi(new Request("https://example.test/api/accuracy"), { STOCK_STATE }, new URL("https://example.test/api/accuracy"));
  const rebuilt = await response.json();
  assert.equal(rebuilt.status, "collecting");
  assert.equal(rebuilt.rebuildRequired, true);
  assert.equal(rebuilt.overall.sampleCount, 0);
});

test("retries a failed compatibility-ledger write without duplicating the evaluation event", async () => {
  const STOCK_STATE = createMemoryKv();
  const prediction = makePendingPredictionRecord();
  STOCK_STATE.values.set(`prediction:${prediction.predictionId}`, JSON.stringify(prediction));
  STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify([prediction.predictionId]));
  STOCK_STATE.values.set("predictions:2026-08-24", JSON.stringify({ tradeDate: "2026-08-24", forecasts: [prediction] }));
  const put = STOCK_STATE.put;
  let failLedgerWrite = true;
  STOCK_STATE.put = async (key, value) => {
    if (key === "predictions:2026-08-24" && failLedgerWrite) {
      failLedgerWrite = false;
      throw new Error("compatibility ledger write failed");
    }
    return put(key, value);
  };
  const env = {
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  };
  const fetchImpl = maturityQuoteFetch([["600001.SH", "20260825", 10, 11.5, 9, 11]]);

  await assert.rejects(evaluatePredictionsJob(env, Date.UTC(2026, 7, 26, 7, 10), fetchImpl), /compatibility ledger write failed/);
  assert.equal(JSON.parse(STOCK_STATE.values.get("prediction-events:f1")).length, 1);

  const accuracy = await evaluatePredictionsJob(env, Date.UTC(2026, 7, 26, 7, 11), fetchImpl);
  const events = JSON.parse(STOCK_STATE.values.get("prediction-events:f1"));
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "evaluation:f1:2026-08-25");
  assert.equal(accuracy.overall.sampleCount, 1);
  assert.equal(JSON.parse(STOCK_STATE.values.get("predictions:2026-08-24")).forecasts[0].status, "evaluated");
});

test("clamps maximum adverse excursion to zero when the full path is favorable", async () => {
  const STOCK_STATE = createMemoryKv();
  const up = makePendingPredictionRecord();
  const down = makePendingPredictionRecord({
    id: "f2",
    predictionId: "f2",
    code: "600002",
    tsCode: "600002.SH",
    referencePrice: 20,
    probabilityUp: 0.4,
    predictedDirection: "down",
  });
  STOCK_STATE.values.set(`prediction:${up.predictionId}`, JSON.stringify(up));
  STOCK_STATE.values.set(`prediction:${down.predictionId}`, JSON.stringify(down));
  STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify([up.predictionId, down.predictionId]));
  STOCK_STATE.values.set("predictions:2026-08-24", JSON.stringify({ tradeDate: "2026-08-24", forecasts: [up, down] }));

  await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 10), maturityQuoteFetch([
    ["600001.SH", "20260825", 11, 12, 10.5, 11.5],
    ["600002.SH", "20260825", 19, 19.5, 17, 18],
  ]));

  assert.equal(JSON.parse(STOCK_STATE.values.get("prediction-events:f1"))[0].patch.maximumAdverseExcursion, 0);
  assert.equal(JSON.parse(STOCK_STATE.values.get("prediction-events:f2"))[0].patch.maximumAdverseExcursion, 0);
});

test("records a maturity evaluation event without overwriting the frozen prediction", async () => {
  const STOCK_STATE = createMemoryKv();
  const frozenPrediction = makePendingPredictionRecord();
  const missingPrediction = makePendingPredictionRecord({
    id: "f2",
    predictionId: "f2",
    code: "600002",
    tsCode: "600002.SH",
    name: "无行情样本",
    referencePrice: 20,
    probabilityUp: 0.4,
    predictedDirection: "down",
  });
  STOCK_STATE.values.set("prediction:f1", JSON.stringify(frozenPrediction));
  STOCK_STATE.values.set("prediction:f2", JSON.stringify(missingPrediction));
  STOCK_STATE.values.set("prediction-due:2026-08-25", JSON.stringify(["f1", "f2"]));
  STOCK_STATE.values.set("predictions:2026-08-24", JSON.stringify({
    tradeDate: "2026-08-24",
    status: "open",
    forecasts: [
      {
        id: "f1",
        predictionId: "f1",
        status: "pending",
        evidenceCompleteness: "complete",
        horizon: "1d",
        cycle: "波段",
        code: "600001",
        tsCode: "600001.SH",
        name: "样本甲",
        industry: "银行",
        marketRegime: "bull",
        maturityTradeDate: "2026-08-25",
        referencePrice: 10,
        probabilityUp: 0.6,
        predictedDirection: "up",
        topAgents: ["谭琦"],
      },
      {
        id: "f2",
        predictionId: "f2",
        status: "pending",
        evidenceCompleteness: "complete",
        horizon: "1d",
        cycle: "波段",
        code: "600002",
        tsCode: "600002.SH",
        name: "无行情样本",
        maturityTradeDate: "2026-08-25",
        referencePrice: 20,
        probabilityUp: 0.4,
        predictedDirection: "down",
        topAgents: ["谭琦"],
      },
    ],
  }));
  const accuracy = await evaluatePredictionsJob({
    TUSHARE_PRIMARY_TOKEN: "secret",
    TUSHARE_PRIMARY_API_URL: "https://market.example.test",
    STOCK_STATE,
  }, Date.UTC(2026, 7, 26, 7, 10), async (_url, init) => {
    const request = JSON.parse(init.body);
    assert.equal(request.api_name, "daily");
    assert.equal(request.params.trade_date, "20260825");
    assert.equal(request.fields, "ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount");
    return new Response(JSON.stringify({
      code: 0,
      data: { fields: ["ts_code", "trade_date", "open", "high", "low", "close"], items: [["600001.SH", "20260825", 10.2, 11.5, 9, 11]] },
    }), { status: 200 });
  });

  assert.equal(accuracy.overall.sampleCount, 1);
  assert.equal(accuracy.overall.hitRate, null);
  assert.equal(accuracy.overall.sampleStatus, "insufficient");
  assert.equal(accuracy.evaluation.newlyEvaluated, 1);
  assert.equal(accuracy.evaluation.overdueMissingClose, 1);
  const ledger = JSON.parse(STOCK_STATE.values.get("predictions:2026-08-24"));
  assert.equal(ledger.forecasts[0].actualPrice, 11);
  assert.equal(ledger.forecasts[0].actualReturn, 0.1);
  assert.equal(ledger.forecasts[0].actualDirection, "up");
  assert.equal(ledger.forecasts[0].hit, true);
  assert.equal(ledger.forecasts[0].brierScore, 0.16);
  assert.equal(ledger.forecasts[0].maximumAdverseExcursion, -0.1);
  assert.equal(ledger.forecasts[0].status, "evaluated");
  assert.equal(ledger.forecasts[1].status, "pending");
  assert.equal(STOCK_STATE.values.get("prediction:f1"), JSON.stringify(frozenPrediction));
  assert.equal(STOCK_STATE.values.has("prediction-events:f2"), false);
  const events = JSON.parse(STOCK_STATE.values.get("prediction-events:f1"));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "evaluation");
  assert.equal(events[0].reason, "maturity_market_data_available");
  assert.deepEqual(events[0].patch, {
    status: "evaluated",
    actualPrice: 11,
    actualReturn: 0.1,
    actualDirection: "up",
    hit: true,
    brierScore: 0.16,
    maximumAdverseExcursion: -0.1,
    evaluatedAt: "2026-08-26T07:10:00.000Z",
    evaluationEvidence: { provider: "Tushare主源", endpoint: "daily", tradeDate: "2026-08-25", tsCode: "600001.SH",
      open: 10.2, high: 11.5, low: 9, close: 11, fetchedAt: "2026-08-26T07:10:00.000Z", ruleVersion: "legacy-close-direction" },
  });
});

test("eight collection rounds use Shanghai time and have no off-window catch-up", () => {
  const slots = new Set();
  for (let minute = 0; minute < 1440; minute++) {
    const plan = scheduledJobPlan(Date.UTC(2026, 8, 9, -8, minute), true);
    if (plan.jobs.length) slots.add(plan.slot);
    assert.deepEqual(applyDailyCatchUp(plan, {}, true).jobs, plan.jobs);
  }
  assert.deepEqual([...slots], ["07:20", "09:26", "10:30", "11:35", "13:05", "14:00", "17:40", "22:00"]);
  const at = (h, m) => scheduledJobPlan(Date.UTC(2026, 8, 9, h - 8, m), true);
  assert.ok(at(7,20).jobs.includes("top50"));
  assert.ok(at(9,26).jobs.includes("opening-auction"));
  assert.equal(at(9,30).slot, "09:26");
  assert.equal(at(9,31).jobs.length, 0);
  assert.equal(at(9,33).jobs.length, 0);
  assert.equal(at(10,5).jobs.length, 0);
  assert.ok(at(17,40).jobs.includes("accuracy"));
  assert.ok(at(22,0).jobs.includes("market-close"));
  const rest = new Set();
  for (let minute = 0; minute < 1440; minute++) {
    const plan = scheduledJobPlan(Date.UTC(2026, 8, 12, -8, minute), false);
    if (plan.jobs.length) rest.add(plan.slot);
  }
  assert.deepEqual([...rest], ["08:30", "22:00"]);
});

test("falls back to index.html for an unknown app route", async () => {
  const calls = [];
  const response = await worker.fetch(
    new Request("https://example.test/flow/step-two?source=share", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (request) => {
          const url = new URL(request.url);
          calls.push(url.pathname + url.search);
          return new Response(url.pathname === "/index.html" ? "app" : "missing", {
            status: url.pathname === "/index.html" ? 200 : 404,
          });
        },
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["/flow/step-two?source=share", "/index.html"]);
});

test("does not turn missing API or write requests into the app shell", async () => {
  for (const request of [
    new Request("https://example.test/api/missing", { headers: { accept: "application/json" } }),
    new Request("https://example.test/flow", { method: "POST", headers: { accept: "text/html" } }),
  ]) {
    let calls = 0;
    const response = await worker.fetch(request, {
      ASSETS: {
        fetch: async () => {
          calls += 1;
          return new Response("missing", { status: 404 });
        },
      },
    });

    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  }
});

test("emits the files required by Sites packaging", async () => {
  await access(new URL("../dist/client/index.html", import.meta.url));
  await access(new URL("../dist/server/index.js", import.meta.url));
  await access(new URL("../dist/.openai/hosting.json", import.meta.url));
});
