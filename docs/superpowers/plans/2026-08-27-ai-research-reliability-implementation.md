# AI Research Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 1—12 个老师 Agent 的研究任务可排队、可重试、可观测，并严格区分独立结果和共享模型降级。

**Architecture:** 延续现有异步 AI Job 接口，增加纯函数错误分类、带超时的单 Agent 执行器和逐 Agent 状态更新；任务按老师顺序单并发执行。前端轮询同一 Job，展示每位老师的真实状态和降级标签。

**Tech Stack:** JavaScript ESM、MiniMax/OpenAI-compatible HTTP、Cloudflare Worker execution context、React 19、Node test runner。

**Spec:** `docs/superpowers/specs/2026-08-27-research-evidence-operations-upgrade-design.md`

## Global Constraints

- 同一任务最多一个 MiniMax 请求在执行。
- 单次连接 10 秒、总请求 70 秒；可重试错误只重试一次。
- 全部独立 Agent 失败后才允许共享模型降级。
- 共享模型降级不得增加独立成功数或 Agent 共识数。
- 任务最长 15 分钟；公开错误必须脱敏。

---

### Task 1: 错误分类与单 Agent 重试执行器

**Files:**
- Modify: `worker/index.js`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `classifyAiError(error) -> { category, retryable, publicMessage }`
- Produces: `runAgentWithRetry({ teacher, request, onState, now, sleep }) -> Promise<AgentAttemptResult>`
- Consumes: 现有 `requestAI`。

- [ ] **Step 1: 写错误分类失败测试**

```js
test("classifies AI failures without leaking provider details", () => {
  const result = classifyAiError(new Error("HTTP 429 https://api.minimax.chat?key=secret"));
  assert.deepEqual(result, { category: "rate_limit", retryable: true, publicMessage: "AI服务繁忙，系统已按策略重试。" });
  assert.doesNotMatch(JSON.stringify(result), /secret|minimax\.chat/);
});
```

- [ ] **Step 2: 写一次重试失败测试**

使用注入的 `request` 第一次抛 `HTTP 504`、第二次返回结果；断言状态顺序为 `analyzing,retrying,completed` 且调用次数为 2。

- [ ] **Step 3: 实现分类和执行器**

```js
function classifyAiError(error) {
  const text = String(error?.message || error).toLowerCase();
  const category = /401|403|auth/.test(text) ? "auth" : /quota/.test(text) ? "quota" : /429|rate/.test(text) ? "rate_limit" : /timeout|abort/.test(text) ? "timeout" : /empty/.test(text) ? "empty_response" : /valid|json|schema/.test(text) ? "validation" : "upstream";
  const retryable = ["rate_limit", "timeout", "upstream"].includes(category);
  return { category, retryable, publicMessage: retryable ? "AI服务繁忙，系统已按策略重试。" : "本次老师研判未完成，请稍后重试。" };
}
```

- [ ] **Step 4: 运行测试与提交**

Run: `npm run test:sites`

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: classify and retry agent requests"
```

### Task 2: 顺序队列、任务截止和独立成功统计

**Files:**
- Modify: `worker/index.js` (`/api/ai/research`, `/api/ai/jobs`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: Job 字段 `agentStates`, `independentSuccessCount`, `independentFailureCount`, `fallbackMode`, `startedAt`, `completedAt`。
- Consumes: Task 1 的 `runAgentWithRetry`。

- [ ] **Step 1: 写单并发和部分成功失败测试**

```js
test("runs selected teacher agents sequentially and preserves partial success", async () => {
  let active = 0;
  let peak = 0;
  const request = async (teacher) => {
    active += 1; peak = Math.max(peak, active);
    try { if (teacher.name === "老师2") throw new Error("HTTP 401"); return { content: teacher.name }; }
    finally { active -= 1; }
  };
  const result = await runTeacherQueue(makeTeachers(3), { request });
  assert.equal(peak, 1);
  assert.equal(result.independentSuccessCount, 2);
  assert.equal(result.fallbackMode, null);
});
```

- [ ] **Step 2: 实现顺序队列**

使用 `for...of` 而非 `Promise.all`；每次状态变化调用 `updateAiJob`。任务开始保存 `deadlineAt = startedAt + 15分钟`，进入下一位老师前检查截止时间，超时的剩余老师标记 `failed/category: timeout`。

- [ ] **Step 3: 写全部失败降级测试**

断言三位独立老师全部失败时只调用一次 `runSharedFallback`，返回 `fallbackMode: "shared_model"`、`independentSuccessCount: 0`，且 `consensus.agentCount: 0`。

- [ ] **Step 4: 实现降级门槛和 90 天运行记录**

研究 Job 主键继续兼容 `ai-job:<clientId>:<jobId>`，同时写 `ai-run:<jobId>`，TTL 为 `90 * 86400`；记录模型名、老师版本、耗时与错误分类，不记录完整提示词或知识正文。

- [ ] **Step 5: 运行测试与提交**

Run: `npm run test:sites && npm run build`

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: queue independent teacher agents"
```

### Task 3: AI 研究室进度与降级展示

**Files:**
- Modify: `src/App.jsx` (`AILabPage`, agent labels)
- Modify: `src/styles.css`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Consumes: `GET /api/ai/jobs/:id` 的逐 Agent 状态和 `fallbackMode`。
- Produces: 用户可见逐老师进度、部分成功说明、共享模型降级标签。

- [ ] **Step 1: 写源码契约失败测试**

```js
test("AI lab exposes independent and fallback semantics", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /independentSuccessCount/);
  assert.match(source, /共享模型降级/);
  assert.match(source, /未计入老师共识/);
});
```

- [ ] **Step 2: 更新轮询终态**

轮询遇到 `completed` 或 `failed` 立即停止；15 分钟前保持进度，超过 `deadlineAt` 显示“任务已超过执行上限”，不继续无限轮询。

- [ ] **Step 3: 更新逐 Agent 卡片**

显示老师名、`waiting/analyzing/retrying/completed/failed`、耗时和脱敏原因；部分成功展示“独立完成 X/Y”，共享降级展示“共享模型降级，未计入老师共识”。

- [ ] **Step 4: 完成可访问性与回归**

状态容器使用 `aria-live="polite"`；发送按钮执行中禁用但页面可滚动，窄屏输入框和发送区不遮挡。运行：`npm run test:sites && npm run build`。

- [ ] **Step 5: 提交**

```bash
git add src/App.jsx src/styles.css tests/sites-worker.test.mjs
git commit -m "feat: show auditable agent progress"
```
