import test from "node:test";
import assert from "node:assert/strict";
import { screenResearchAnswer, guardResearchResult, buildSelectedStockSource, classifyAiError, handleApi } from "../worker/index.js";

const quote = buildSelectedStockSource({ code: "600036", name: "招商银行", trade_date: "20260828", close: 39.54, pct_chg: -0.1, high: 40, low: 39, amount: 1200 });
const check = (text, sources = [quote]) => screenResearchAnswer(text, sources);
test("dated explicit quote values with the correct source pass the bounded screen", () => {
  assert.equal(check("2026-08-28收盘39.54，涨跌幅-0.10%，最高40，最低39 [M2]。").status, "screened");
});
test("wrong price and wrong source type cannot support a quote", () => {
  assert.ok(check("收盘39.55 [M2]").issues.includes("quote_value_or_source_mismatch"));
  assert.ok(check("收盘39.54 [N1]", [{ ...quote, id: "N1", type: "news" }]).issues.includes("quote_value_or_source_mismatch"));
});
test("unknown and duplicate source IDs are rejected", () => {
  assert.ok(check("据[N99]公告").issues.includes("unknown_source_id"));
  assert.ok(check("概念说明", [quote, quote]).issues.includes("duplicate_source_id"));
});
test("old close cannot be labeled today's close", () => {
  const old = buildSelectedStockSource({ code: "600036", trade_date: "20010101", close: 10 });
  assert.ok(check("今日收盘10 [M2]", [old]).issues.includes("quote_date_mismatch"));
});
test("numeric hit rates remain forbidden even when the percentage appears in a source", () => {
  assert.ok(check("预测命中率80% [N1]", [{ id: "N1", excerpt: "80%" }]).issues.includes("unverified_accuracy"));
});
test("quotes must carry their actual trading date, not another date or no date", () => {
  assert.ok(check("2026-08-31收盘39.54 [M2]").issues.includes("quote_date_missing_or_mismatch"));
  assert.ok(check("收盘39.54 [M2]").issues.includes("quote_date_missing_or_mismatch"));
});
test("percentage matching is numeric, not a substring match", () => {
  assert.ok(check("上涨3.1% [N1]", [{ id: "N1", excerpt: "13.1%" }]).issues.includes("unsupported_percentage"));
});
test("general explanation and negative realtime disclaimer are allowed", () => {
  assert.equal(check("均线是价格的移动平均，可辅助观察趋势，不能保证盈利。不是实时行情。").status, "screened");
  assert.ok(check("这是实时行情").issues.includes("unverified_realtime"));
  assert.ok(check("老师本人已买入").issues.includes("unverified_teacher_position"));
});
test("missing provider fields remain missing and cannot support numbers", () => {
  const missing = buildSelectedStockSource({ code: "600036", trade_date: "20260828" });
  assert.match(missing.excerpt, /涨跌幅未提供/);
  assert.doesNotMatch(missing.excerpt, /undefined|NaN|null|未提供%/);
  assert.ok(check("收盘0 [M2]", [missing]).issues.includes("quote_value_or_source_mismatch"));
});
test("blocked raw prose becomes a nonretryable public-safe validation error", () => {
  assert.throws(() => guardResearchResult({ text: "收盘888 [M2]" }, [quote]), (error) => {
    const classified = classifyAiError(error);
    assert.equal(classified.category, "validation");
    assert.equal(classified.retryable, false);
    assert.doesNotMatch(classified.publicMessage, /888|quote_value/);
    return true;
  });
});

function memory() {
  const values = new Map();
  return { values, get: async key => values.get(key) || null, put: async (key, value) => values.set(key, value),
    list: async () => ({ keys: [], list_complete: true }) };
}
const answer = text => new Response(JSON.stringify({ model: "test", choices: [{ message: { content: text } }], base_resp: { status_code: 0 } }));
test("research route removes unverified browser stock facts and persists screening metadata", async () => {
  const STOCK_STATE = memory();
  const url = new URL("https://test/api/ai/research");
  const response = await handleApi(new Request(url, { method: "POST", body: JSON.stringify({
    clientId: "evidence-test", question: "说明证据缺失时如何处理", teacher: { name: "谭琦" },
    stock: { code: "600036", tsCode: "WRONG.EXCHANGE", name: "虚假名称", price: 888888, industry: "虚假行业" },
  }) }), { STOCK_STATE, MINIMAX_API_KEY: "test" }, url, async (_url, init) => {
    assert.doesNotMatch(init.body, /虚假名称|888888|虚假行业|WRONG.EXCHANGE/);
    return answer("尚未取得有效个股行情，不提供价格判断。");
  });
  const result = await response.json();
  assert.equal(result.verification.status, "screened");
  const thread = JSON.parse(STOCK_STATE.values.get(`ai-thread:evidence-test:${result.threadId}`));
  assert.equal(thread.messages.at(-1).verification.status, "screened");
});
test("concept questions do not receive unrelated monitoring quotes", async () => {
  const STOCK_STATE = memory();
  await STOCK_STATE.put("market:latest", JSON.stringify({ meta: { generatedAt: "2026-08-28T07:00:00Z" }, quotes: [{ code: "000001", price: 11 }] }));
  const url = new URL("https://test/api/ai/research");
  const response = await handleApi(new Request(url, { method: "POST", body: JSON.stringify({ question: "解释移动平均线", teacher: { name: "谭琦" } }) }), { STOCK_STATE, MINIMAX_API_KEY: "test" }, url, async (_url, init) => {
    const content = JSON.parse(init.body).messages.at(-1).content;
    const context = JSON.parse(content.slice(content.indexOf("{", content.indexOf("上下文"))));
    assert.equal(context.marketScope, null);
    assert.deepEqual(context.top50, []);
    assert.ok(!context.sources.some(source => source.id === "M1"));
    return answer("移动平均线用于平滑价格波动，不保证预测正确。");
  });
  assert.equal((await response.json()).verification.status, "screened");
});
test("invalid synthesis is withheld while screened independent replies are preserved", async () => {
  const url = new URL("https://test/api/ai/research");
  let calls = 0;
  const response = await handleApi(new Request(url, { method: "POST", body: JSON.stringify({ question: "说明研究局限", teachers: [{ name: "谭琦" }, { name: "养家" }] }) }), { STOCK_STATE: memory(), MINIMAX_API_KEY: "test" }, url, async () => answer(++calls <= 2 ? "缺少数据时应保留判断。" : "确定命中率99%"));
  const result = await response.json();
  assert.equal(result.summaryStatus, "summary_unavailable");
  assert.equal(result.agentResponses.length, 2);
  assert.equal(result.summaryErrorCategory, "validation");
  assert.doesNotMatch(JSON.stringify(result), /99%/);
});
test("invalid independent and fallback replies never reach the user as research prose", async () => {
  const url = new URL("https://test/api/ai/research");
  await assert.rejects(() => handleApi(new Request(url, { method: "POST", body: JSON.stringify({ question: "说明证据", teacher: { name: "谭琦" } }) }), { STOCK_STATE: memory(), MINIMAX_API_KEY: "test" }, url, async () => answer("虚构事实[N999]")), /原文已拦截/);
});
