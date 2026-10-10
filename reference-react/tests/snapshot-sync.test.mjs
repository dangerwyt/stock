import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncLocalSnapshots } from "../scripts/sync-local-snapshots.mjs";

test("sync keeps original timestamps, excludes secrets and resumes bounded immutable batches", async () => {
  const root = await mkdtemp(join(tmpdir(), "snapshot-sync-"));
  const stateFile = join(root, "state.json");
  const generatedAt = "2026-09-08T02:00:00Z";
  const state = {};
  const put = (key, value) => { state[key] = { value: JSON.stringify(value) }; };
  put("news:latest", { meta: { generatedAt }, items: [{ title: "真实测试样本" }] });
  put("market:latest", { meta: { generatedAt, tradeDate: "2026-09-07" }, quotes: [] });
  put("private-key", { secret: "NEVER_COPY" });
  put("top50:latest", { meta: { tradeDate: "2026-09-08", snapshotId: "frozen", expectedPredictionCount: 300 } });
  for (let i = 0; i < 300; i++) put(`prediction:${i}`, { predictionId: String(i), snapshotId: "frozen", generatedAt: "2026-09-07T23:35:00Z" });
  await writeFile(stateFile, JSON.stringify(state));
  const calls = [];
  const options = { stateFile, checkpointFile: join(root, "checkpoint.json"), baseUrl: "https://test.invalid", token: "test-token",
    now: Date.parse("2026-09-08T04:00:00Z"), fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); return Response.json({ status: "completed" }); } };
  assert.equal((await syncLocalSnapshots(options)).predictionCount, 200);
  assert.equal((await syncLocalSnapshots(options)).predictionCount, 300);
  const count = calls.length;
  await syncLocalSnapshots(options);
  assert.equal(calls.length, count);
  assert.equal(calls[0].news.meta.generatedAt, generatedAt);
  assert.ok(calls.every(body => !body.market));
  assert.doesNotMatch(JSON.stringify(calls), /NEVER_COPY/);
  assert.equal(calls.flatMap(body => body.predictions || []).length, 300);
});
