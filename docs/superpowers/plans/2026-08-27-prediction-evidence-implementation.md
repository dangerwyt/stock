# Prediction Evidence and Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 TOP50 预测保存为不可变、可追溯的证据账本，并由到期真实行情生成分层准确率。

**Architecture:** 保持现有 Cloudflare Worker 单文件结构，以纯函数扩展预测结构和统计逻辑；KV 中同时保留旧 `predictions:<date>` 兼容读取和新的单预测证据键。React 准确率页只消费派生接口，不自行计算业务指标。

**Tech Stack:** JavaScript ESM、Cloudflare KV-compatible storage、Node test runner、React 19、Vite。

**Spec:** `docs/superpowers/specs/2026-08-27-research-evidence-operations-upgrade-design.md`

## Global Constraints

- 预测生成后不可覆盖；更正以事件追加。
- 只有 `evaluated` 且证据完整的样本进入主要准确率。
- 分组 `sampleCount < 10` 时 `hitRate` 必须为 `null` 并返回 `sampleStatus: "insufficient"`。
- 不生成静态准确率、随机结果或收益承诺。
- 保持现有 `/api/top50` 和 `/api/accuracy` 字段向后兼容。

---

### Task 1: 冻结预测结构与不可变写入

**Files:**
- Modify: `worker/index.js` (`buildTop50Snapshot`, `generateTop50Job`, export list)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `buildPredictionRecord({ snapshotId, cycle, item, tradeDate, maturityTradeDate, horizon, generatedAt, dataLineage, teacherVersions, marketRegime }) -> PredictionRecord`
- Produces: `appendPredictionEvent(env, predictionId, event) -> Promise<PredictionEvent[]>`
- Consumes: 现有 `writeState`, `readState`, `buildTop50Snapshot`。

- [ ] **Step 1: 写冻结结构失败测试**

```js
test("freezes auditable prediction identity and evidence", () => {
  const result = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00.000Z");
  const forecast = result.ledger.forecasts[0];
  assert.equal(forecast.predictionId, forecast.id);
  assert.ok(forecast.snapshotId);
  assert.equal(forecast.dataCutoff, "2026-08-27T07:35:00.000Z");
  assert.deepEqual(forecast.lifecycle, { status: "pending", revision: 1 });
  assert.equal(forecast.evidenceCompleteness, "complete");
  assert.ok(forecast.dataLineage.marketProvider);
});
```

- [ ] **Step 2: 运行定向测试并确认失败**

Run: `node --test --test-name-pattern='freezes auditable prediction' tests/sites-worker.test.mjs`

Expected: FAIL，缺少 `predictionId`、`dataCutoff` 或 `lifecycle`。

- [ ] **Step 3: 实现最小冻结记录**

```js
function buildPredictionRecord({ snapshotId, cycle, item, tradeDate, maturityTradeDate, horizon, generatedAt, dataLineage, teacherVersions, marketRegime }) {
  const predictionId = `${compactDate(tradeDate)}:${cycle}:${item.tsCode}:${horizon.id}`;
  return {
    id: predictionId,
    predictionId,
    snapshotId,
    tradeDate,
    cycle,
    rank: item.rank,
    code: item.code,
    tsCode: item.tsCode,
    name: item.name,
    industry: item.industry,
    horizon: horizon.id,
    horizonLabel: horizon.label,
    maturityTradeDate,
    referencePrice: item.close,
    probabilityUp: item.probabilityUp,
    predictedDirection: item.probabilityUp >= 0.5 ? "up" : "down",
    triggerPrice: item.triggerPrice,
    invalidPrice: item.invalidPrice,
    invalidationRule: `收盘价低于${item.invalidPrice}`,
    topAgents: item.topAgents,
    agentVotes: item.agentVotes,
    teacherVersions,
    factorVersion: "agent-factor-v2",
    marketRegime,
    dataCutoff: generatedAt,
    generatedAt,
    dataLineage,
    evidenceCompleteness: "complete",
    lifecycle: { status: "pending", revision: 1 },
    status: "pending",
  };
}
```

- [ ] **Step 4: 写并通过不可变事件测试**

测试 `appendPredictionEvent` 读取旧数组并追加 `{ eventId, type, occurredAt, reason, patch }`，不修改 `prediction:<id>` 原始对象。运行：`node --test --test-name-pattern='prediction event' tests/sites-worker.test.mjs`。

- [ ] **Step 5: 写入单预测键并运行回归**

`generateTop50Job` 读取 12 位老师当前生产知识版本；根据参考交易日上证指数相对 20 日均线和 20 日波动率生成 `bull`、`range`、`risk_off` 或 `unknown` 市场状态。保存日期账本后，对 `ledger.forecasts` 执行 `writeState(env, \`prediction:${forecast.predictionId}\`, forecast, { expirationTtl: 3 * 366 * 86400 })`。运行 `npm run test:sites`。

- [ ] **Step 6: 提交**

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: freeze auditable prediction records"
```

### Task 2: 旧预测保守迁移

**Files:**
- Modify: `worker/index.js`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `migrateLegacyPrediction(forecast, ledger) -> PredictionRecord`
- Produces: `POST /api/admin/migrations/prediction-evidence`，继续使用现有 `requireAdmin`。
- Consumes: 旧 `predictions:<date>` 日期账本。

- [ ] **Step 1: 写不推断未知字段的失败测试**

```js
test("marks legacy evidence partial without inventing missing facts", () => {
  const migrated = migrateLegacyPrediction({ id: "old-1", code: "600000", status: "pending" }, { tradeDate: "2026-08-20" });
  assert.equal(migrated.predictionId, "old-1");
  assert.equal(migrated.evidenceCompleteness, "partial");
  assert.equal(migrated.teacherVersions, null);
  assert.equal(migrated.marketRegime, null);
  assert.equal(migrated.dataLineage, null);
});
```

- [ ] **Step 2: 实现纯迁移函数**

只复制旧记录中已存在的值；补充 `predictionId`、`lifecycle.revision = 1` 和 `evidenceCompleteness = "partial"`。不存在的事实字段写 `null`，不得从股票名称、日期或当前快照反推。

- [ ] **Step 3: 写管理端接口幂等测试**

无管理令牌返回 401；第一次迁移写入 `prediction:<id>`；第二次执行返回 `skipped` 且不覆盖已有单预测记录；响应返回迁移、跳过和失败数量。

- [ ] **Step 4: 实现迁移接口并运行回归**

接口枚举 `predictions:`，跳过 `prediction:` 和 `prediction-events:`；每批最多处理 500 条，避免一次请求无界运行。运行：`npm run test:sites`。

- [ ] **Step 5: 提交**

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: migrate legacy prediction evidence"
```

### Task 3: 到期评估事件与分层统计

**Files:**
- Modify: `worker/index.js` (`evaluatePredictionsJob`, `calculateAccuracy`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `summarizeAccuracy(items, minimumSample = 10) -> AccuracyMetric`
- Produces: `calculateAccuracy(forecasts) -> AccuracySnapshot`
- Consumes: Task 1 的 `PredictionRecord` 和 `appendPredictionEvent`。

- [ ] **Step 1: 写小样本与完整样本失败测试**

```js
test("withholds grouped hit rate below ten complete samples", () => {
  const metric = calculateAccuracy(makeEvaluatedForecasts(9)).overall;
  assert.equal(metric.sampleCount, 9);
  assert.equal(metric.hitRate, null);
  assert.equal(metric.sampleStatus, "insufficient");
});

test("publishes calibrated metrics at ten complete samples", () => {
  const metric = calculateAccuracy(makeEvaluatedForecasts(10)).overall;
  assert.equal(metric.sampleStatus, "sufficient");
  assert.equal(typeof metric.hitRate, "number");
  assert.equal(typeof metric.brierScore, "number");
});
```

- [ ] **Step 2: 运行并确认旧逻辑错误显示百分比**

Run: `node --test --test-name-pattern='samples|calibrated metrics' tests/sites-worker.test.mjs`

Expected: 第一个测试 FAIL，旧逻辑返回数值命中率。

- [ ] **Step 3: 实现统一统计函数**

```js
function summarizeAccuracy(items, minimumSample = 10) {
  const complete = items.filter((item) => item.status === "evaluated" && item.evidenceCompleteness !== "partial");
  const sufficient = complete.length >= minimumSample;
  return {
    sampleCount: complete.length,
    sampleStatus: sufficient ? "sufficient" : "insufficient",
    hitRate: sufficient ? Number((complete.filter((item) => item.hit).length / complete.length * 100).toFixed(1)) : null,
    brierScore: sufficient ? Number((complete.reduce((sum, item) => sum + Number(item.brierScore), 0) / complete.length).toFixed(4)) : null,
    averageReturn: sufficient ? Number((complete.reduce((sum, item) => sum + Number(item.actualReturn), 0) / complete.length).toFixed(6)) : null,
    maximumAdverseExcursion: sufficient ? Math.min(...complete.map((item) => Number(item.maximumAdverseExcursion ?? 0))) : null,
  };
}
```

- [ ] **Step 4: 扩展评估数据并追加事件**

`evaluatePredictionsJob` 查询到期日 `open,high,low,close`，写入 `actualPrice`、`actualReturn`、`actualDirection`、`hit`、`brierScore`、`maximumAdverseExcursion`、`evaluatedAt`，并追加 `evaluation` 事件；没有行情时保持 `pending`。

- [ ] **Step 5: 增加行业和市场状态分组并回归**

`calculateAccuracy` 返回 `industries`、`marketRegimes`、`byAgent`，全部调用 `summarizeAccuracy`。运行：`npm run test:sites && npm run build`。

- [ ] **Step 6: 提交**

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: calculate stratified evidence accuracy"
```

### Task 4: 证据 API 与准确率页面

**Files:**
- Modify: `worker/index.js` (`handleApi`)
- Modify: `src/App.jsx` (`AccuracyPage`)
- Modify: `src/styles.css`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `GET /api/accuracy/evidence?predictionId=<id>`。
- Consumes: `prediction:<id>`、`prediction-events:<id>`、`accuracy:latest`。

- [ ] **Step 1: 写证据接口失败测试**

```js
test("returns frozen prediction with append-only evaluation events", async () => {
  const kv = createMemoryKv();
  kv.values.set("prediction:p1", JSON.stringify({ predictionId: "p1", status: "pending" }));
  kv.values.set("prediction-events:p1", JSON.stringify([{ type: "evaluation", occurredAt: "2026-08-27T15:10:00Z" }]));
  const response = await handleApi(new Request("https://example.test/api/accuracy/evidence?predictionId=p1"), { STOCK_STATE: kv }, new URL("https://example.test/api/accuracy/evidence?predictionId=p1"));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).events.map((item) => item.type), ["evaluation"]);
});
```

- [ ] **Step 2: 实现严格 ID 校验和 404**

仅接受 `safeId` 处理后的 ID；不存在时返回 `{ error: "prediction evidence not found" }` 和 404，不回退到其他股票。

- [ ] **Step 3: 更新页面样本门槛与证据入口**

`AccuracyPage` 在 `sampleStatus === "insufficient"` 时显示“样本不足（n/10）”；最近记录每行增加“查看证据”按钮和可关闭证据浮层，浮层显示冻结时间、数据截止、来源、失效规则、事件时间线。

- [ ] **Step 4: 完成键盘语义与样式**

浮层使用 `role="dialog" aria-modal="true"`；保存触发按钮引用，`Escape` 关闭后恢复焦点。运行：`npm run test:sites && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add worker/index.js src/App.jsx src/styles.css tests/sites-worker.test.mjs
git commit -m "feat: expose prediction evidence details"
```
