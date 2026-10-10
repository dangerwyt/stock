# Operations and Commercial Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立脱敏运维中心、状态变化告警和可重复的商业化发布验收证据。

**Architecture:** 调度和供应商调用写入统一运维事件，接口从事件与当前快照派生健康状态；告警按组件和错误分类去重。React 新增运维页；现有负载与 soak 脚本扩展为发布门禁。

**Tech Stack:** JavaScript ESM、Cloudflare KV、React 19、Node test runner、Vite、现有本地调度脚本。

**Spec:** `docs/superpowers/specs/2026-08-27-research-evidence-operations-upgrade-design.md`

## Global Constraints

- 运维页面只读、脱敏，不增加登录系统。
- 管理操作继续要求服务端管理令牌。
- 状态固定为 `healthy`、`degraded`、`critical`、`unknown`。
- 无观察时间不得显示健康；同类告警 60 分钟内只通知一次。
- 正式完成需要浏览器矩阵、负载、8 小时 soak 和两个完整 A 股交易日证据。

---

### Task 1: 运维事件与状态聚合

**Files:**
- Modify: `worker/index.js` (`runScheduled`, provider jobs, `handleApi`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `recordOpsEvent(env, event) -> Promise<OpsEvent>`
- Produces: `buildOperationsSnapshot({ events, status, now }) -> OperationsSnapshot`
- Produces: `GET /api/operations`。

- [ ] **Step 1: 写状态聚合失败测试**

```js
test("operations status requires an observation timestamp", () => {
  const snapshot = buildOperationsSnapshot({ events: [], status: {}, now: Date.parse("2026-08-27T10:00:00Z") });
  assert.equal(snapshot.components.market.status, "unknown");
  assert.equal(snapshot.components.market.observedAt, null);
});
```

- [ ] **Step 2: 写脱敏失败测试**

给事件传入含 URL、Token 和堆栈的错误，断言 `/api/operations` 响应不匹配 `/https?:|token|stack|secret/i`，但保留 `errorCategory` 和 `consecutiveFailures`。

- [ ] **Step 3: 实现事件结构与聚合**

```js
const OPS_COMPONENTS = ["market", "news", "ai", "scheduler", "notification"];

async function recordOpsEvent(env, event) {
  const occurredAt = event.occurredAt || new Date().toISOString();
  const value = { eventId: crypto.randomUUID(), component: event.component, outcome: event.outcome, errorCategory: event.errorCategory || null, durationMs: event.durationMs ?? null, occurredAt };
  await writeState(env, `ops-event:${value.eventId}`, value, { expirationTtl: 90 * 86400 });
  return value;
}
```

聚合计算最后成功/失败、连续失败、P95、快照年龄、队列深度和最近恢复；只返回允许字段。

- [ ] **Step 4: 接入关键任务并实现接口**

`runScheduled`、行情、新闻、AI Job 和通知在成功/失败/恢复时记录事件；`GET /api/operations` 从最近事件及 `/api/status` 所需状态构建快照，缓存 30 秒。

- [ ] **Step 5: 运行测试与提交**

Run: `npm run test:sites`

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: add sanitized operations telemetry"
```

### Task 2: 状态变化告警与恢复通知

**Files:**
- Modify: `worker/index.js` (`sendNotification`, `runScheduled`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `transitionComponentState(env, component, nextState, context, now) -> Promise<{ changed, notification }>`。
- Consumes: Task 1 的 `recordOpsEvent`。

- [ ] **Step 1: 写去重与恢复失败测试**

```js
test("notifies once per state transition and once on recovery", async () => {
  const first = await transitionComponentState(env, "market", "degraded", { errorCategory: "rate_limit" }, now);
  const duplicate = await transitionComponentState(env, "market", "degraded", { errorCategory: "rate_limit" }, now + 5 * 60_000);
  const recovered = await transitionComponentState(env, "market", "healthy", {}, now + 20 * 60_000);
  assert.equal(first.changed, true);
  assert.equal(duplicate.changed, false);
  assert.equal(recovered.notification.type, "component_recovered");
});
```

- [ ] **Step 2: 实现状态机和 60 分钟冷却**

状态键为 `ops-state:<component>`；通知锁为 `ops-alert:<component>:<errorCategory>`，TTL 3600 秒。健康转降级、降级转严重和异常转健康时通知；重复只累计次数。

- [ ] **Step 3: 将系统错误从股票风险结论分离**

`buildRiskSnapshot` 不再接收供应商原始通知；风险页只展示股票/组合风险。系统错误只在运维中心和通知中心出现。

- [ ] **Step 4: 运行测试与提交**

Run: `npm run test:sites`

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: deduplicate operational alerts"
```

### Task 3: 运维页面

**Files:**
- Modify: `src/App.jsx` (`navItems`, page routing, new `OperationsPage`)
- Modify: `src/styles.css`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Consumes: `GET /api/operations`。
- Produces: 左侧“运行状态”入口和五类组件状态页。

- [ ] **Step 1: 写页面契约失败测试**

```js
test("operations page is read-only and timestamped", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /function OperationsPage/);
  assert.match(source, /运行状态/);
  assert.match(source, /observedAt/);
  assert.doesNotMatch(source, /显示原始错误/);
});
```

- [ ] **Step 2: 实现页面和路由**

新增 `{ id: "operations", label: "运行状态", icon: IconActivity }`；卡片显示状态、最后成功、连续失败、P95、快照年龄和恢复时间。`unknown` 使用中性灰，不能使用绿色。

- [ ] **Step 3: 完成响应式、加载与空状态**

接口不可用时显示“运行状态暂不可用”和最后已知时间；390px 单列，桌面双列；所有时间按 Asia/Shanghai 显示。

- [ ] **Step 4: 运行回归与提交**

Run: `npm run test:sites && npm run build`

```bash
git add src/App.jsx src/styles.css tests/sites-worker.test.mjs
git commit -m "feat: add read-only operations center"
```

### Task 4: 自动化发布门禁与证据包

**Files:**
- Modify: `scripts/load-smoke.mjs`
- Modify: `scripts/scheduler-soak.mjs`
- Modify: `tests/ops-validation.test.mjs`
- Modify: `package.json`
- Create: `scripts/release-static-scan.mjs`
- Create at execution time: `audit-commercial-release-2026-08-27/README.md`

**Interfaces:**
- Produces: `npm run test:release-static`。
- Produces: `npm run test:load -- --total=200 --concurrency=20 --p95=500`。
- Produces: `npm run test:soak -- --hours=8`。

- [ ] **Step 1: 写脚本失败条件测试**

`tests/ops-validation.test.mjs` 覆盖：任一 5xx 退出 1、P95 超过 500ms 退出 1、调度时间不前进退出 1、响应出现禁用静态字段或无时间戳 `实时` 标签退出 1。

- [ ] **Step 2: 扩展负载脚本**

默认请求 `/api/status`、`/api/market`、`/api/top50`、`/api/news`、`/api/accuracy`、`/api/operations`；汇总每个接口的成功数、5xx、P50/P95，任何门槛失败设置 `process.exitCode = 1`。

- [ ] **Step 3: 扩展 soak 与静态扫描**

soak 每分钟检查调度推进、快照时间、任务卡死和重复告警；`release-static-scan.mjs` 扫描构建产物和 API 样本中的 `Math.random` 业务生成、固定命中率、无时间戳实时标签及密钥模式。

- [ ] **Step 4: 增加 npm 命令并运行短验收**

```json
"test:release-static": "node scripts/release-static-scan.mjs"
```

Run: `npm run test:sites && npm run test:ops && npm run build && npm run test:release-static && npm run test:load -- --total=200 --concurrency=20 --p95=500 && npm run test:soak -- --minutes=5`

- [ ] **Step 5: 浏览器矩阵验收**

使用真实页面依次检查 1440×900、1024×768、509×865、390×844。覆盖首页、四周期 TOP10、证据浮层、资讯原文、AI 多老师发送、准确率、运行状态；记录截图、DOM 尺寸、控制台错误和键盘焦点。

- [ ] **Step 6: 开始长时门禁并如实记录状态**

运行 `npm run test:soak -- --hours=8`；随后跨两个完整 A 股交易日记录行情、TOP50、新闻、评估和通知。未达到持续时间前，报告必须写“长时验收进行中”，不能宣称完成。

- [ ] **Step 7: 提交自动化与当时已有证据**

```bash
git add scripts/load-smoke.mjs scripts/scheduler-soak.mjs scripts/release-static-scan.mjs tests/ops-validation.test.mjs package.json audit-commercial-release-2026-08-27/README.md
git commit -m "test: add commercial release acceptance gates"
```
