import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const secretPatterns = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bbobo_sk_[A-Za-z0-9_-]{12,}\b/,
  /\btsr_[A-Za-z0-9_-]{20,}\b/,
  /\btk_live_[A-Za-z0-9_-]{20,}\b/,
];
const businessPatterns = [
  { name: "random business output", pattern: /Math\.random\s*\(/ },
  { name: "fixed hit-rate claim", pattern: /命中率[^\n]{0,30}\b\d{1,2}(?:\.\d+)?%/ },
];

async function filesUnder(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  }));
  return nested.flat();
}

export function scanText(text, { business = false } = {}) {
  const findings = [];
  secretPatterns.forEach((pattern) => {
    if (pattern.test(text)) findings.push("embedded secret pattern");
  });
  if (business) businessPatterns.forEach(({ name, pattern }) => {
    if (pattern.test(text)) findings.push(name);
  });
  return findings;
}

export function validateApiSample(value, path = "response") {
  const findings = [];
  if (Array.isArray(value)) return value.flatMap((item, index) => validateApiSample(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return findings;
  const timestamped = ["generatedAt", "observedAt", "publishedAt", "dataCutoff", "createdAt", "time", "date"].some((key) => value[key]);
  const hasRealtimeLabel = Object.values(value).some((item) => typeof item === "string" && /^(实时|实时数据|实时行情)$/.test(item.trim()));
  if (hasRealtimeLabel && !timestamped) findings.push(`${path}: realtime label lacks timestamp`);
  for (const [key, item] of Object.entries(value)) findings.push(...validateApiSample(item, `${path}.${key}`));
  return findings;
}

export async function runStaticScan({ root = resolve("."), baseUrl = "http://127.0.0.1:4173", fetchImpl = fetch } = {}) {
  const sourceFiles = [...await filesUnder(join(root, "worker")), ...await filesUnder(join(root, "src"))].filter((file) => [".js", ".jsx"].includes(extname(file)));
  const builtFiles = (await filesUnder(join(root, "dist"))).filter((file) => [".js", ".css", ".html", ".json"].includes(extname(file)));
  const findings = [];
  for (const file of [...sourceFiles, ...builtFiles]) {
    const text = await readFile(file, "utf8");
    const issues = scanText(text, { business: file === join(root, "worker", "index.js") });
    issues.forEach((issue) => findings.push(`${relative(root, file)}: ${issue}`));
  }
  for (const path of ["/api/status", "/api/market", "/api/top50", "/api/news", "/api/accuracy", "/api/operations"]) {
    const response = await fetchImpl(new URL(path, baseUrl), { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`static scan sample failed: ${path} HTTP ${response.status}`);
    validateApiSample(await response.json(), path).forEach((issue) => findings.push(issue));
  }
  if (findings.length) throw new Error(`release static scan failed:\n${findings.join("\n")}`);
  return { status: "passed", sourceFiles: sourceFiles.length, builtFiles: builtFiles.length, apiSamples: 6 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseIndex = process.argv.indexOf("--base");
  const result = await runStaticScan({ baseUrl: baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined });
  console.log(JSON.stringify(result, null, 2));
}
