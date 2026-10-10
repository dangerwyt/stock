# TOP50 and News Information Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TOP50 提供冻结选股证据，并用可审计评分筛选首页新闻及解释海外向 A 股的影响路径。

**Architecture:** TOP50 证据直接从冻结快照和预测账本生成；新闻使用确定性评分函数，AI 只允许补充摘要。页面复用现有单股浮层和四周期标签，增加证据入口与评分拆解。

**Tech Stack:** JavaScript ESM、Cloudflare KV、React 19、Node test runner、Vite。

**Spec:** `docs/superpowers/specs/2026-08-27-research-evidence-operations-upgrade-design.md`

## Global Constraints

- 首页四周期各显示真实 TOP10 或明确空数据原因。
- TOP50 旧快照不重排，新因子版本只影响新快照。
- 新闻总分固定为来源 25、金融相关 25、时效 20、实体匹配 20、A 股传导 10。
- 娱乐内容直接拒绝；普通 `ETF` 不等于美股。
- 新闻点击打开原始 URL，不生成伪全文。

---

### Task 1: TOP50 证据结构与查询接口

**Files:**
- Modify: `worker/index.js` (`buildTop50Snapshot`, `handleApi`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `buildSelectionEvidence(snapshot, prediction, events) -> SelectionEvidence`
- Produces: `GET /api/top50/evidence?predictionId=<id>`。
- Consumes: `prediction:<id>`、`prediction-events:<id>`、`top50:snapshot:<snapshotId>`。

- [ ] **Step 1: 写证据完整性失败测试**

```js
test("TOP50 ranking carries immutable selection evidence", () => {
  const { snapshot } = buildTop50Snapshot(sampleRows(60), "2026-08-27", futureDates, "2026-08-27T07:35:00Z");
  const item = snapshot.cycles["超短"].ranking[0];
  assert.ok(item.selectionEvidence.factorBreakdown);
  assert.ok(item.selectionEvidence.supportingAgents.length);
  assert.ok(item.selectionEvidence.trigger);
  assert.ok(item.selectionEvidence.invalidation);
  assert.equal(item.selectionEvidence.dataCutoff, snapshot.meta.generatedAt);
});
```

- [ ] **Step 2: 实现证据字段并保存历史快照**

`generateTop50Job` 除 `top50:latest` 外写入 `top50:snapshot:<snapshotId>`；快照 TTL 为 `3 * 366 * 86400`。`snapshotId` 使用本次生成时间的统一主 ID，各周期保留自己的 `cycleSnapshotId`。

- [ ] **Step 3: 写接口成功、缺失与非法 ID 测试**

成功返回 `prediction`、`selectionEvidence`、`events`；合法但不存在返回 404；非法 ID 返回 400；接口不得按代码猜测其他预测。

- [ ] **Step 4: 实现接口并回归**

Run: `npm run test:sites`

- [ ] **Step 5: 提交**

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: persist TOP50 selection evidence"
```

### Task 2: 新闻确定性评分、过滤与去重

**Files:**
- Modify: `worker/index.js` (`inferNewsImpact`, `normalizeNews`, `filterUniqueNewsArticles`)
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Produces: `scoreNewsArticle(article, generatedAt) -> { score, scoreBreakdown, tier, rejected, rejectionReason }`
- Produces: `inferNewsEntities(article) -> { relatedStocks, relatedIndustries, transmissionPath }`
- Consumes: 当前 `inferNewsImpact` 的市场分类结果。

- [ ] **Step 1: 写评分边界失败测试**

```js
test("scores auditable A-share relevance and rejects entertainment", () => {
  const primary = scoreNewsArticle(makeCninfoDisclosure(), "2026-08-27T09:30:00Z");
  assert.equal(primary.score, Object.values(primary.scoreBreakdown).reduce((sum, value) => sum + value, 0));
  assert.ok(primary.score >= 70);
  assert.equal(primary.tier, "primary");
  const noise = scoreNewsArticle({ title: "明星综艺热搜", sourceId: "weibo", publishedAt: "2026-08-27T09:20:00Z" }, "2026-08-27T09:30:00Z");
  assert.equal(noise.rejected, true);
});
```

- [ ] **Step 2: 写市场分类回归测试**

A 股公告标题包含“ETF”仍为 `A股/中国`；含 Nasdaq/Federal Reserve 的海外稿为 `美股/全球`；港交所稿为 `港股`。

- [ ] **Step 3: 实现固定分项算法**

```js
function scoreNewsArticle(article, generatedAt) {
  if (!isRelevantMarketNews(article)) return { score: 0, scoreBreakdown: {}, tier: "rejected", rejected: true, rejectionReason: "non_financial" };
  const scoreBreakdown = {
    sourceTrust: sourceTrustScore(article),
    financialRelevance: financialRelevanceScore(article),
    timeliness: timelinessScore(article.publishedAt, generatedAt),
    entityMatch: entityMatchScore(article),
    aShareTransmission: transmissionScore(article),
  };
  const score = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
  return { score, scoreBreakdown, tier: score >= 70 ? "primary" : score >= 50 ? "standard" : "watch", rejected: false, rejectionReason: null };
}
```

- [ ] **Step 4: 接入采集和事件去重**

`normalizeNews` 写入 `marketScope`、实体、行业、评分、原因和传导路径；`filterUniqueNewsArticles` 以规范化标题 + 6 小时时间窗归并同一事件，主条目选择来源可信度更高者，其他 URL 放入 `relatedSources`。

- [ ] **Step 5: 运行测试与提交**

Run: `npm run test:sites`

```bash
git add worker/index.js tests/sites-worker.test.mjs
git commit -m "feat: score and classify financial news"
```

### Task 3: TOP50 与新闻页面交互

**Files:**
- Modify: `src/App.jsx` (`HomeTop50Summary`, `Top50Page`, `HomeNewsRail`, `NewsPage`)
- Modify: `src/styles.css`
- Test: `tests/sites-worker.test.mjs`

**Interfaces:**
- Consumes: `/api/top50`, `/api/top50/evidence`, `/api/news`。
- Produces: 四周期 TOP10、选股证据浮层、新闻评分标签与原文跳转。

- [ ] **Step 1: 写源码行为失败测试**

```js
test("home previews ten stocks and news exposes scoring evidence", async () => {
  const source = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /ranking\.slice\(0, 10\)/);
  assert.match(source, /scoreBreakdown/);
  assert.match(source, /选股证据/);
});
```

- [ ] **Step 2: 更新首页 TOP10 与空状态**

四周期标签均取 `ranking.slice(0, 10)`；缺失时展示 `snapshot.reason`、最后成功时间和“等待下一次 07:35 冻结榜单”，不得只留下表头。

- [ ] **Step 3: 增加选股证据浮层**

点击“选股证据”按 `predictionId` 请求接口；浮层显示入选理由、因子拆解、支持/反对 Agent、触发、失效、来源截止和评估时间线。请求失败显示错误状态，不回退到静态内容。

- [ ] **Step 4: 更新新闻层级与链接**

首页只展示 `tier === "primary"`；资讯中心提供主要/普通/全球观察标签，显示分数和分类原因；标题使用 `<a href={item.url} target="_blank" rel="noreferrer">`。

- [ ] **Step 5: 完成响应式和键盘验收前置**

在 390px 下表格改为可读列表但页面无横向滚动；标签支持方向键或标准 Tab；浮层支持 `Escape` 和焦点返回。运行：`npm run test:sites && npm run build`。

- [ ] **Step 6: 提交**

```bash
git add src/App.jsx src/styles.css tests/sites-worker.test.mjs
git commit -m "feat: expose TOP50 and news evidence UI"
```
