export function validateContract(path, body) {
  const stamp = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${path}: invalid response`);
  const valid = {
    "/api/status": () => stamp(body.health?.scheduler?.lastRunAt),
    "/api/market": () => stamp(body.meta?.generatedAt) && Array.isArray(body.quotes) && typeof body.health?.status === "string",
    "/api/top50": () => stamp(body.meta?.generatedAt) && ["超短", "短线", "波段", "中长线"].every((cycle) => Array.isArray(body.cycles?.[cycle]?.ranking)),
    "/api/news": () => stamp(body.meta?.generatedAt) && Array.isArray(body.items),
    "/api/accuracy": () => Number.isFinite(body.overall?.sampleCount) && body.overall.sampleCount >= 0,
    "/api/operations": () => stamp(body.generatedAt) && body.components && Number.isFinite(body.aiBudget?.usedCalls),
    "/api/notifications": () => Array.isArray(body.items),
  }[path];
  if (valid && !valid()) throw new Error(`${path}: missing or invalid required fields`);
}

export function accuracyGateErrors(snapshot) {
  const errors = [];
  const groups = { overall: snapshot?.overall, ...Object.fromEntries(
    ["cycles", "horizons", "directions", "industries", "marketRegimes", "byAgent", "byStock", "factorVersions"].flatMap((name) =>
      Object.entries(snapshot?.[name] || {}).map(([key, value]) => [`${name}.${key}`, value])),
  ) };
  for (const [name, metric] of Object.entries(groups)) {
    if (!metric) continue;
    if ((!Number.isFinite(metric.sampleCount) || metric.sampleCount < 30) &&
      [metric.hitRate, metric.brierScore, metric.averageReturn].some((value) => value != null)) errors.push(`${name}: metrics published below 30-sample gate`);
    if ((metric.pairedSampleCount || 0) < 30 && [metric.averageExcessReturn, metric.benchmarkAverageReturn].some((v) => v != null)) errors.push(`${name}: benchmark published below paired gate`);
  }
  return errors;
}
