import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalKv } from "../vite.config.mjs";

test("local KV preserves Cloudflare metadata, pagination, delete, and valid JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stock-local-kv-"));
  const filePath = join(directory, "state.json");

  try {
    const kv = createLocalKv(filePath);
    await kv.put("ops-recent:2", "second", { metadata: { status: "healthy" } });
    await kv.put("ops-recent:1", "first", { metadata: { status: "degraded" } });

    const firstPage = await kv.list({ prefix: "ops-recent:", limit: 1 });
    assert.equal(firstPage.keys.length, 1);
    assert.deepEqual(firstPage.keys[0].metadata, { status: "degraded" });
    assert.equal(firstPage.list_complete, false);

    const secondPage = await kv.list({ prefix: "ops-recent:", limit: 1, cursor: firstPage.cursor });
    assert.equal(secondPage.keys[0].name, "ops-recent:2");
    assert.equal(secondPage.list_complete, true);

    const reloaded = createLocalKv(filePath);
    const reloadedKeys = await reloaded.list({ prefix: "ops-recent:" });
    assert.deepEqual(reloadedKeys.keys[0].metadata, { status: "degraded" });
    await reloaded.delete("ops-recent:1");
    assert.equal(await reloaded.get("ops-recent:1"), null);
    const persistedSource = await readFile(filePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(persistedSource));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
