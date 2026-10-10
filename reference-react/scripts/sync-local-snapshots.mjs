import { readFile, writeFile, rename } from "node:fs/promises";

// Only already collected public snapshots and original frozen predictions cross environments.
export async function syncLocalSnapshots({ stateFile, checkpointFile, baseUrl, token, fetchImpl = fetch, now = Date.now() }) {
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  let checkpoint = {};
  try { checkpoint = JSON.parse(await readFile(checkpointFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const read = (key) => {
    const entry = state[key];
    return entry && (!entry.expiresAt || entry.expiresAt > now) ? JSON.parse(entry.value) : null;
  };
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format(now);
  const post = async (body) => {
    const response = await fetchImpl(new URL("/api/admin/bootstrap-snapshots", baseUrl), { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Snapshot sync HTTP ${response.status}`);
    const result = await response.json();
    if (result.status !== "completed") throw new Error("Snapshot sync not completed");
  };
  const save = async () => {
    await writeFile(`${checkpointFile}.tmp`, JSON.stringify(checkpoint), { mode: 0o600 });
    await rename(`${checkpointFile}.tmp`, checkpointFile);
  };
  const imported = [];
  for (const [field, key] of [["news", "news:latest"], ["market", "market:latest"], ["usEtfMap", "us-etf-map:latest"]]) {
    const snapshot = read(key);
    const generatedAt = snapshot?.meta?.generatedAt;
    if (!generatedAt || !Number.isFinite(Date.parse(generatedAt)) || Date.parse(generatedAt) > now) continue;
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format(Date.parse(generatedAt));
    if (date !== today || (field === "market" && snapshot.meta.tradeDate !== today) || checkpoint[field] === generatedAt) continue;
    await post({ [field]: snapshot });
    checkpoint[field] = generatedAt;
    imported.push(field);
    await save();
  }
  const top50 = read("top50:latest");
  if (top50?.meta?.tradeDate === today && top50.meta.expectedPredictionCount > 0) {
    const id = top50.meta.snapshotId;
    const forecasts = Object.keys(state).filter((key) => key.startsWith("prediction:")).map(read)
      .filter((item) => item?.snapshotId === id).sort((a, b) => a.predictionId.localeCompare(b.predictionId));
    if (forecasts.length !== top50.meta.expectedPredictionCount) return { imported, predictions: "incomplete_local_evidence" };
    if (checkpoint.snapshotId !== id) {
      await post({ top50 });
      checkpoint.snapshotId = id;
      checkpoint.offset = 0;
      await save();
    }
    // Two bounded batches per tick, resumable after a timeout without replacing frozen records.
    for (let batch = 0; batch < 2 && checkpoint.offset < forecasts.length; batch++) {
      const predictions = forecasts.slice(checkpoint.offset, checkpoint.offset + 100);
      await post({ predictions });
      checkpoint.offset += predictions.length;
      await save();
    }
  }
  return { imported, predictionCount: checkpoint.offset || 0, snapshotId: checkpoint.snapshotId || null };
}
