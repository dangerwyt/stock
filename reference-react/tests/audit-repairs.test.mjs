import assert from "node:assert/strict";
import test from "node:test";
import worker, { buildTop50Snapshot, collectNewsJob, generateTop50Job, handleApi, resumeAiJobs, teacherDistillationJob, sanitizeNewsSnapshot, readStates } from "../worker/index.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalKv } from "../vite.config.mjs";
import { readRequestJson } from "../worker/http.js";
import { runLoadSmoke } from "../scripts/load-smoke.mjs";
import { runSoakChecks } from "../scripts/scheduler-soak.mjs";
import { accuracyGateErrors } from "../scripts/api-contracts.mjs";
import { fetchSharedSnapshot } from "../src/use-shared-snapshot.js";

test("lowest value factor remains zero rather than rebounding to neutral", () => {
  const rows = [10, 90, 100].map((pe, i) => ({ ts_code: `00000${i+1}.SZ`, name: "fixture", close: 10,
    open: 10, high: 11, low: 9, pre_close: 10, pct_chg: 1, amount: 100, turnover_rate: 1,
    volume_ratio: 1, pe_ttm: pe, pb: 1, total_mv: 1, trade_date: "20260904" }));
  const { snapshot } = buildTop50Snapshot(rows, "2026-09-07", ["2026-09-08"], "2026-09-06T23:35:00Z");
  const ranking = snapshot.cycles["中长线"].ranking;
  assert.ok(ranking.find(x=>x.peTtm===90).agentScores["曹名长"] > ranking.find(x=>x.peTtm===100).agentScores["曹名长"]);
});

test("all 4xx and malformed success responses fail load acceptance", async () => {
  for (const status of [403, 404, 429, 200]) await assert.rejects(runLoadSmoke({ baseUrl: "https://test.invalid",
    total: 2, concurrency: 1, fetchImpl: async () => Response.json({}, { status }) }), /returned errors/);
});

test("missing heartbeat cannot pass soak acceptance", async () => {
  await assert.rejects(runSoakChecks({ baseUrl: "https://test.invalid", iterations: 12, intervalMs: 0,
    fetchImpl: async () => Response.json({}) }), /missing or invalid/);
});

test("group and paired sample gates are independently verified", () => {
  const errors = accuracyGateErrors({ overall: { sampleCount: 100, hitRate: 40 }, cycles: { "短线": { sampleCount: 2, hitRate: 50 } },
    industries: { "银行": { sampleCount: 40, pairedSampleCount: 2, averageExcessReturn: 0.1 } } });
  assert.equal(errors.length, 2);
});

test("actual bytes enforce request limit without Content-Length, including unicode", async () => {
  for (const padding of ["x".repeat(70000), "股".repeat(30000)]) {
    const request = new Request("https://test.invalid", { method: "POST", body: JSON.stringify({ padding }) });
    await assert.rejects(readRequestJson(request), error => error.status === 413);
  }
  await assert.rejects(readRequestJson(new Request("https://test.invalid", { method: "POST", body: "{" })), error => error.status === 400);
});

test("public errors never return raw backend details", async () => {
  const response = await worker.fetch(new Request("https://test.invalid/api/top50"), { STOCK_STATE: { get: async () => { throw new Error("PRIVATE_SENTINEL"); } } });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.ok(body.requestId);
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_SENTINEL/);
});

test("concurrent snapshots share a request", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ id: 1 }); };
  const items = await Promise.all(Array.from({length: 10}, () => fetchSharedSnapshot("/audit-coalesced", fetcher)));
  assert.equal(calls, 1);
  assert.equal(items.length, 10);
});

test("irrelevant primary news falls back to financial news and enters bounded recovery", async () => {
  const values = new Map();
  const STOCK_STATE = { get: async k => values.get(k) || null, put: async (k,v) => values.set(k,v), list: async()=>({keys:[],list_complete:true}) };
  let primary = 0;
  const env = { STOCK_STATE, QINGHONG_API_KEY: "test", TUSHARE_PRIMARY_TOKEN: "test" };
  const fetcher = async (url) => {
    if (String(url).includes("finance/entire")) { primary++; return Response.json([{id:"xueqiu-hotstock",items:[{title:"银行市场关注度",url:"https://finance.test/ignored",pubDate:Date.now()}]}]); }
    return Response.json({ code: 0, data: { fields: ["title","url","pub_time","src"], items: [["央行发布货币政策 支持A股市场流动性", "https://finance.test/news", new Intl.DateTimeFormat("sv-SE", { timeZone:"Asia/Shanghai", dateStyle:"short", timeStyle:"medium" }).format(new Date()), "新浪财经"]] } });
  };
  const first = await collectNewsJob(env, fetcher);
  assert.equal(first.meta.fallbackActive, true);
  const observations = [...values.entries()].filter(([key])=>key.startsWith("source-observation:")).map(([,value])=>JSON.parse(value));
  assert.equal(observations.find((item)=>item.provider==="晴红")?.status,"failed");
  await collectNewsJob(env, fetcher);
  assert.equal(primary, 1);
});

test("local persistence recovers after an IO failure and coalesces concurrent writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-recovery-"));
  const file = join(directory, "state.json");
  const kv = createLocalKv(file);
  await kv.get("ready");
  await mkdir(file);
  await assert.rejects(kv.put("first", "one"));
  await rename(file, join(directory, "blocked-path"));
  await Promise.all(Array.from({length: 100}, (_,i) => kv.put(`key:${i}`, String(i))));
  const state = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.keys(state).length, 101);
  assert.equal(state.first.value, "one");
});

test("D1 TOP50 resumes in batches without rewriting frozen records", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const DB = { prepare(sql) {
    const statement = sqlite.prepare(sql);
    const make = (values = []) => ({ bind: (...args) => make(args),
      run: async () => ({meta: {changes: Number(statement.run(...values).changes)}}),
      first: async () => statement.get(...values) || null,
      all: async () => ({results: statement.all(...values)}),
    });
    return make();
  }, batch: async (statements) => Promise.all(statements.map(s => s.run())) };
  sqlite.exec("CREATE TABLE state_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const rows = Array.from({length: 50}, (_,i) => ({ts_code: `${600000+i}.SH`, name: "fixture", close: 10, open:10, high:11, low:9, pre_close:10, pct_chg:1, amount:1000000, turnover_rate:1, volume_ratio:1, pe_ttm:i+1, pb:1, total_mv:10000, trade_date:"20260904"}));
  const now = Date.parse("2026-09-06T23:35:00Z");
  const dates = Array.from({length:80}, (_,i) => new Date(Date.parse("2026-09-08")+i*86400000).toISOString().slice(0,10));
  const result = buildTop50Snapshot(rows, "2026-09-07", dates, new Date(now).toISOString());
  sqlite.prepare("INSERT INTO state_store(key,value) VALUES (?,?)").run("top50-build:2026-09-07:agent-factor-v3-zero-preserving", JSON.stringify({result,offset:0}));
  const first = await generateTop50Job({DB}, now, () => { throw new Error("must use checkpoint"); });
  assert.equal(first.status, "pending");
  assert.equal(first.saved, 100);
  const frozen = sqlite.prepare("SELECT key,value FROM state_store WHERE key LIKE 'prediction:%' LIMIT 1").get();
  let final = first;
  for(let i=0; i<10 && final.status==="pending"; i++) final = await generateTop50Job({DB}, now);
  assert.ok(final.cycles);
  assert.equal(sqlite.prepare("SELECT value FROM state_store WHERE key=?").get(frozen.key).value, frozen.value);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM state_store WHERE key LIKE 'prediction:%'").get().n, result.ledger.forecasts.length);
  await assert.rejects(generateTop50Job({DB}, Date.parse("2026-09-07T01:16:00Z")), /窗口已结束/);
  sqlite.close();
});

test("cancelled consultation cannot advance or call AI", async () => {
  const values = new Map();
  const STOCK_STATE = {get: async k=>values.get(k)||null, put: async(k,v)=>values.set(k,v), delete: async k=>values.delete(k), list: async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))})};
  const env = {STOCK_STATE, MINIMAX_API_KEY:"test"};
  const post = (path, body) => handleApi(new Request(`https://test.invalid${path}`, {method:"POST",body:JSON.stringify(body)}), env, new URL(`https://test.invalid${path}`), ()=>{throw new Error("AI must not run");});
  const accepted = await (await post("/api/ai/jobs", {clientId:"cancel-test", question:"研究风险",teachers:[{name:"谭琦"}],incremental:true})).json();
  assert.ok(accepted.job?.id);
  const cancelled = await (await post(`/api/ai/jobs/${accepted.job.id}/cancel`, {clientId:"cancel-test"})).json();
  assert.equal(cancelled.job.phase, "cancelled");
  const advanced = await (await post(`/api/ai/jobs/${accepted.job.id}/advance`, {clientId:"cancel-test",step:0})).json();
  assert.equal(advanced.job.phase, "cancelled");
  assert.equal(values.has(`ai-resume:${accepted.job.id}`), false);
});

test("background runner completes persisted conversation without browser advances", async () => {
  const values = new Map();
  const STOCK_STATE = {get: async k=>values.get(k)||null, put: async(k,v)=>values.set(k,v), delete: async k=>values.delete(k), list: async({prefix})=>({keys:[...values.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name}))})};
  const env = {STOCK_STATE, MINIMAX_API_KEY:"test", MINIMAX_MODEL:"MiniMax-M3"};
  let calls = 0;
  const provider = async()=> { calls++; return Response.json({choices:[{message:{content:"仅依据证据，资料不足，等待核验。"}}]}); };
  const url = new URL("https://test.invalid/api/ai/jobs");
  const response = await handleApi(new Request(url,{method:"POST",body:JSON.stringify({clientId:"offline-test",question:"风险研究",teachers:[{name:"谭琦"},{name:"养家"}],incremental:true})}),env,url,provider);
  const {job} = await response.json();
  for(let i=0;i<4;i++) await resumeAiJobs(env,provider);
  const endpoint = new URL(`https://test.invalid/api/ai/jobs/${job.id}?clientId=offline-test`);
  const completed = await (await handleApi(new Request(endpoint),env,endpoint,provider)).json();
  assert.equal(completed.job.status,"completed");
  assert.equal(completed.job.result.agentResponses.length,2);
  assert.equal(calls,3);
  assert.equal(values.has(`ai-resume:${job.id}`),false);
});

test("distillation does not claim completion for idle or all-failed teachers", async () => {
  const env = {MINIMAX_API_KEY:"test", STOCK_STATE:{get:async()=>null,put:async()=>{},list:async()=>({keys:[]})}};
  assert.equal((await teacherDistillationJob(env)).status,"no_changes");
  env.STOCK_STATE.get = async()=>{throw new Error("fixture storage unavailable");};
  const failed = await teacherDistillationJob(env);
  assert.equal(failed.status,"failed");
  assert.equal(failed.failed,12);
});

test("old news cannot claim a currently working backup provider", () => {
  const snapshot = {meta:{generatedAt:new Date(Date.now()-30*60000).toISOString(),sourceMode:"live",providerHealth:[{provider:"backup",status:"ready"}]},items:[]};
  const result = sanitizeNewsSnapshot(snapshot);
  assert.equal(result.meta.delayed,true);
  assert.equal(result.meta.sourceMode,"cached");
  assert.equal(result.meta.providerHealth[0].status,"stale");
  assert.equal(result.meta.generatedAt,snapshot.meta.generatedAt);
  assert.equal(snapshot.meta.sourceMode,"live", "do not rewrite stored evidence");
});

test("batched state reads use one query and preserve order, zero and expiry", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE state_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const insert = sqlite.prepare("INSERT INTO state_store(key,value,expires_at) VALUES (?,?,?)");
  insert.run("zero","0",null); insert.run("no","false",null); insert.run("bad","{",null); insert.run("expired","1",Date.now()-1000);
  let queries=0;
  const DB={prepare(sql){const stmt=sqlite.prepare(sql);return {run:async()=>stmt.run(),bind(...args){return {all:async()=>{queries++;return {results:stmt.all(...args)};}};}};}};
  assert.deepEqual(await readStates({DB},["expired","zero","no","bad","missing"]),[null,0,false,null,null]);
  assert.equal(queries,1);
  assert.deepEqual(await readStates({DB},[]),[]);
  assert.equal(queries,1);
  assert.deepEqual(await readStates({STOCK_STATE:{get:async key=>key==="zero"?"0":null}},["zero","missing"]),[0,null]);
  sqlite.close();
});
