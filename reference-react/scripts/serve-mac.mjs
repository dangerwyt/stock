import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { Readable } from "node:stream";
import { loadEnv } from "vite";
import { createLocalSqliteDb } from "../vite.config.mjs";
import worker from "../worker/index.js";

const root = resolve("dist/client");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2" };
const env = { ...process.env, ...loadEnv("development", process.cwd(), ""), DB: createLocalSqliteDb(), LOCAL_STATE_PROVIDER: "Local SQLite state store" };
// This machine is standalone; never forward budget or scheduler traffic to Sites.
env.SITES_SCHEDULER_BASE_URL = "";
env.ASSETS = { async fetch(request) {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
  let file = resolve(root, `.${pathname}`);
  if (!file.startsWith(root + sep) && file !== root) return new Response("Forbidden", { status: 403 });
  if (pathname.split("/").some(part => part.startsWith("."))) return new Response("Not found", { status: 404 });
  if (pathname === "/") file = resolve(root, "index.html");
  try {
    const data = await readFile(file);
    return new Response(request.method === "HEAD" ? null : data, { headers: { "content-type": types[extname(file)] || "application/octet-stream", "cache-control": file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache" } });
  } catch { return new Response("Not found", { status: 404 }); }
} };
const pending = new Set();
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 65536) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const request = new Request(new URL(req.url, "http://127.0.0.1:4173"), { method: req.method, headers: req.headers, ...(!["GET", "HEAD"].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
    const response = await worker.fetch(request, env, { waitUntil(promise) { const task = Promise.resolve(promise).catch(() => console.error("Background task failed")).finally(() => pending.delete(task)); pending.add(task); } });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (!response.body || req.method === "HEAD") { res.end(); return; }
    const stream = Readable.fromWeb(response.body);
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch { console.error("HTTP request failed"); if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"internal_error"}'); }
});
server.listen(Number(process.env.PORT || 4173), process.env.HOST || "0.0.0.0", () => console.log("Standalone API and frontend listening"));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(async () => { await Promise.allSettled([...pending]); env.DB.close(); process.exit(0); }));
