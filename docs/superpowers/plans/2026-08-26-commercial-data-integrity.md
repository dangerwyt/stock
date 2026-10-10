# Commercial Data Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复八项商业化数据完整性问题，并以自动化测试和浏览器证据证明用户可见行为。

**Architecture:** 在 `worker/index.js` 内维持现有单文件 Worker 架构，只增加小型纯函数来归一供应商数据、分类资讯和生成安全告警；React 保持现有状态式页面切换，新增准确率页面并补齐 TOP50 行。行情采用主接口关键时间点和 ProMax 单股部分成功合并，不引入新依赖。

**Tech Stack:** React 19、Vite、Cloudflare Worker-compatible API、Node test runner、浏览器验收。

**Spec:** `docs/superpowers/specs/2026-08-26-commercial-data-integrity-design.md`

## Global Constraints

- 不新增付费数据源，不承诺秒级行情。
- 不生成静态业务数字；缺失值必须带原因。
- 不泄露 token、供应商原始错误或内部 URL。
- 日线、基础资料和交易日历等批量数据走 ProMax 聚合 GET 接口；`rt_min` 因实测批量 504 而按单股小并发处理。
- 只修改与八项问题直接相关的代码和测试。

---

### Task 1: ProMax 分钟行情适配与部分成功容灾

**Files:**
- Modify: `worker/index.js`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `normalizeIntradayRow(row, snapshotAt, provider)` 和 `fetchFallbackIntradayQuotes(env, codes, now, fetchImpl)`。
- Consumes: `tushareQuery`、`readState`、`writeState` 和上一份 `market:latest`。

- [ ] 写失败测试：`trade_time` 映射为 `observedAt/time`，两只股票一只成功一只 504 时返回 `partial` 并保留旧报价。
- [ ] 运行 `node --test --test-name-pattern='ProMax|intraday' tests/sites-worker.test.mjs`，确认因函数或行为缺失而失败。
- [ ] 实现单股最多三并发、一次重试、时间字段归一和按代码合并。
- [ ] 将盘中调度改为 10 个关键时间点，保留资讯五分钟任务。
- [ ] 重跑定向测试和完整 `npm run test:sites`。

### Task 2: 新闻市场分类与风险告警安全化

**Files:**
- Modify: `worker/index.js`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `inferNewsImpact(article)` 返回市场和分类原因；`buildUserFacingProviderAlerts(notifications)` 返回去重脱敏告警。

- [ ] 写失败测试：国内来源包含普通 ETF 仍归 A 股；明确 Nasdaq 内容归美股/全球。
- [ ] 写失败测试：同类 `market-pulse` 错误只保留最新一条，且结果不包含 URL、HTTP 504 或接口名。
- [ ] 运行定向测试并确认失败原因正确。
- [ ] 实现来源优先分类和告警分组、摘要、重试时间输出。
- [ ] 运行定向测试与完整测试。

### Task 3: TOP50 首页行与独立准确率证据页

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/styles.css`
- Modify: `worker/index.js`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- `/api/accuracy` 新增 `recentEvaluations`，最多 20 条。
- React 新增 `AccuracyPage`，活动页标识为 `accuracy`。

- [ ] 写失败测试：`calculateAccuracy` 返回最近验证记录且不包含未评估预测。
- [ ] 运行定向测试确认失败。
- [ ] 扩展准确率响应并实现独立页面路由。
- [ ] 将 `HomeTop50Summary` 空占位替换为最多 5 条真实排名。
- [ ] 为标签、表格和准确率页补充响应式样式及键盘语义。
- [ ] 运行完整测试和生产构建。

### Task 4: 量化来源标注与历史自选股回填

**Files:**
- Modify: `worker/index.js`
- Modify: `src/App.jsx`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- 新增 `GET /api/stocks/lookup?codes=000001,600000`。
- 内置量化结果返回 `engine`、`rankingSource`、`marketSource` 和 `marketHealth`。

- [ ] 写失败测试：批量股票查询返回名称、行业和市场；未知代码不伪造名称。
- [ ] 写失败测试：内置量化引擎不返回 `built-in-12-agent-v1` 或不准确的实时来源说明。
- [ ] 运行定向测试确认失败。
- [ ] 实现批量查询、前端缺失信息回填和准确数据源标签。
- [ ] 运行完整测试和生产构建。

### Task 5: 运行与交互验收

**Files:**
- Create: `scripts/load-smoke.mjs`
- Create: `scripts/scheduler-soak.mjs`
- Modify: `package.json`
- Create: `AUDIT_COMMERCIAL_DATA_INTEGRITY_2026-08-26.md`

**Interfaces:**
- `npm run test:load` 对公开 GET API 发出并发 20、累计 200 次请求。
- `npm run test:soak -- --minutes=N` 重复执行只读调度状态和 API 健康检查并输出结果。

- [ ] 先为脚本参数与失败退出码写 Node 测试，并确认失败。
- [ ] 实现最小负载和 soak 脚本。
- [ ] 运行完整测试、生产构建和负载测试。
- [ ] 用浏览器在 1280×720、509×865、390×844 验收首页、准确率、风险、自选和弹层键盘操作。
- [ ] 将截图、DOM、控制台和 API 结果记录在验收报告中；未完成的真实长时间运行必须明确标记为待运行。
