import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

for (const filename of [".env.development.local", ".env.local"]) {
  try {
    const text = await readFile(join(projectRoot, filename), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {}
}

const baseUrl = String(process.env.KNOWLEDGE_SYNC_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
if (!process.env.ADMIN_API_TOKEN) throw new Error("ADMIN_API_TOKEN is required");
const response = await fetch(`${baseUrl}/api/admin/run`, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ job: "teacher-distillation" }),
});
const payload = await response.json();
if (!response.ok) throw new Error(payload.message || payload.error || `weekly distillation HTTP ${response.status}`);
console.log(JSON.stringify({
  status: payload.status,
  created: payload.result?.created || 0,
  idle: (payload.result?.results || []).filter((item) => item.status === "idle").length,
  failed: (payload.result?.results || []).filter((item) => item.status === "failed").length,
}, null, 2));
