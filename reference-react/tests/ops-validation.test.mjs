import assert from "node:assert/strict";
import test from "node:test";
import { runLoadSmoke } from "../scripts/load-smoke.mjs";
import { scanText, validateApiSample } from "../scripts/release-static-scan.mjs";
import { runSoakChecks } from "../scripts/scheduler-soak.mjs";

const fixture = (url) => {
  const now = "2026-08-26T07:10:00.000Z";
  return { health: { scheduler: { lastRunAt: now }, status: "ready" }, meta: { generatedAt: now },
    cycles: Object.fromEntries(["超短", "短线", "波段", "中长线"].map((k) => [k, { ranking: [] }])),
    quotes: [], items: [], generatedAt: now, components: {}, aiBudget: { usedCalls: 0 } };
};

test("load smoke counts successful API responses and rejects server errors", async () => {
  const result = await runLoadSmoke({
    baseUrl: "https://example.test",
    total: 6,
    concurrency: 2,
    paths: ["/api/status", "/api/top50"],
    fetchImpl: async (url) => Response.json(fixture(url)),
  });
  assert.equal(result.total, 6);
  assert.equal(result.failures, 0);
  assert.equal(result.maxStatus, 200);
  assert.equal(result.endpoints["/api/status"].serverErrors, 0);
});

test("load smoke rejects any server error and an excessive P95", async () => {
  await assert.rejects(() => runLoadSmoke({
    baseUrl: "https://example.test",
    total: 2,
    concurrency: 1,
    paths: ["/api/status"],
    fetchImpl: async (_url, _init) => new Response("{}", { status: 503 }),
  }), /returned errors/);

  const originalNow = Date.now;
  let now = 0;
  Date.now = () => { now += 600; return now; };
  try {
    await assert.rejects(() => runLoadSmoke({
      baseUrl: "https://example.test",
      total: 2,
      concurrency: 1,
      p95LimitMs: 500,
      paths: ["/api/status"],
      fetchImpl: async (url) => Response.json(fixture(url)),
    }), /P95 .* exceeds/);
  } finally {
    Date.now = originalNow;
  }
});

test("soak checks detect scheduler timestamps moving backwards", async () => {
  const timestamps = ["2026-08-26T07:10:00.000Z", "2026-08-26T07:00:00.000Z"];
  await assert.rejects(() => runSoakChecks({
    baseUrl: "https://example.test",
    iterations: 2,
    intervalMs: 0,
    now: () => Date.parse("2026-08-26T07:10:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/status")) return new Response(JSON.stringify({ health: { scheduler: { lastRunAt: timestamps.shift() } } }), { status: 200 });
      return Response.json(fixture(url));
    },
  }), /scheduler timestamp regressed/);
});

test("soak checks detect a scheduler that does not advance", async () => {
  await assert.rejects(() => runSoakChecks({
    baseUrl: "https://example.test",
    iterations: 2,
    intervalMs: 0,
    maxSchedulerStagnantChecks: 0,
    now: () => Date.parse("2026-08-26T07:10:00.000Z"),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/status")) return new Response(JSON.stringify({ health: { scheduler: { lastRunAt: "2026-08-26T07:10:00.000Z" } } }), { status: 200 });
      if (String(url).endsWith("/api/notifications")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return Response.json(fixture(url));
    },
  }), /did not advance/);
});

test("release scan rejects business randomness, fixed hit rates, secrets, and unstamped realtime labels", () => {
  assert.deepEqual(scanText("const score = Math.random()", { business: true }), ["random business output"]);
  assert.deepEqual(scanText("方向命中率 55.6%", { business: true }), ["fixed hit-rate claim"]);
  assert.deepEqual(scanText("const key = 'bobo_sk_year_1234567890123456'"), ["embedded secret pattern"]);
  assert.deepEqual(validateApiSample({ label: "实时" }), ["response: realtime label lacks timestamp"]);
  assert.deepEqual(validateApiSample({ label: "实时", generatedAt: "2026-08-26T07:10:00Z" }), []);
});
