import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const knowledgeRoot = join(projectRoot, "teacher-knowledge");
const teacherNames = ["陈江挺", "养家", "谭琦", "曹名长", "产业调研凌", "曹靖楠", "产业调研福总", "菠萝", "曾剑枫", "寻龙一手", "龙一", "短线委员会"];
const textExtensions = new Set([".md", ".txt", ".csv", ".json"]);
const audioExtensions = new Set([".mp3", ".m4a", ".wav", ".aac", ".flac"]);

async function loadLocalEnv() {
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
}

function extractWith(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return "";
  }
}

async function transcriptForAudio(path, fileName) {
  const stem = fileName.slice(0, -extname(fileName).length);
  for (const extension of [".transcript.md", ".transcript.txt"]) {
    try {
      return await readFile(join(path, `${stem}${extension}`), "utf8");
    } catch {}
  }
  if (!process.env.TRANSCRIPTION_API_URL) return "";
  const audio = await readFile(join(path, fileName));
  const form = new FormData();
  form.append("file", new Blob([audio]), fileName);
  const response = await fetch(process.env.TRANSCRIPTION_API_URL, {
    method: "POST",
    headers: process.env.TRANSCRIPTION_API_TOKEN ? { authorization: `Bearer ${process.env.TRANSCRIPTION_API_TOKEN}` } : {},
    body: form,
  });
  if (!response.ok) throw new Error(`transcription HTTP ${response.status}`);
  const payload = await response.json();
  return String(payload.text || payload.transcript || "").trim();
}

async function extractContent(folder, fileName) {
  const extension = extname(fileName).toLowerCase();
  const fullPath = join(folder, fileName);
  if (textExtensions.has(extension)) return readFile(fullPath, "utf8");
  if (extension === ".pdf") return extractWith("pdftotext", [fullPath, "-"]);
  if (extension === ".docx" || extension === ".doc") return extractWith("textutil", ["-convert", "txt", "-stdout", fullPath]);
  if (audioExtensions.has(extension)) return transcriptForAudio(folder, fileName);
  return "";
}

async function metadataFor(folder, fileName) {
  const stem = fileName.slice(0, -extname(fileName).length);
  try {
    return JSON.parse(await readFile(join(folder, `${stem}.meta.json`), "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  await loadLocalEnv();
  const baseUrl = String(process.env.KNOWLEDGE_SYNC_BASE_URL || "http://127.0.0.1:4173").replace(/\/+$/, "");
  if (!process.env.ADMIN_API_TOKEN) throw new Error("ADMIN_API_TOKEN is required");
  if (process.env.KNOWLEDGE_RIGHTS_CONFIRMED !== "true") throw new Error("Set KNOWLEDGE_RIGHTS_CONFIRMED=true only after confirming the materials may be used by this project");
  const summary = { uploaded: 0, duplicates: 0, pendingTranscription: [], unsupported: [], failed: [] };
  for (const teacherName of teacherNames) {
    const inbox = join(knowledgeRoot, teacherName, "inbox");
    await access(inbox);
    const files = await readdir(inbox);
    for (const fileName of files.filter((name) => !name.startsWith(".") && !name.endsWith(".meta.json") && !name.includes(".transcript."))) {
      const extension = extname(fileName).toLowerCase();
      if (![...textExtensions, ...audioExtensions, ".pdf", ".doc", ".docx"].includes(extension)) {
        summary.unsupported.push(`${teacherName}/${fileName}`);
        continue;
      }
      try {
        const content = String(await extractContent(inbox, fileName)).trim();
        if (!content) {
          if (audioExtensions.has(extension)) summary.pendingTranscription.push(`${teacherName}/${fileName}`);
          else summary.failed.push({ file: `${teacherName}/${fileName}`, reason: "no text extracted" });
          continue;
        }
        const metadata = await metadataFor(inbox, fileName);
        const contentHash = createHash("sha256").update(`${teacherName}\n${content}`).digest("hex");
        const response = await fetch(`${baseUrl}/api/teachers/materials`, {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.ADMIN_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            teacherName,
            title: metadata.title || basename(fileName, extension),
            content,
            contentHash,
            mediaType: audioExtensions.has(extension) ? "audio_transcript" : "document",
            originalFileName: fileName,
            sourceName: metadata.sourceName || "本地老师知识文件夹",
            sourceUrl: metadata.sourceUrl || null,
            publishedAt: metadata.publishedAt || null,
            rightsConfirmed: true,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || payload.message || `upload HTTP ${response.status}`);
        if (payload.status === "duplicate") summary.duplicates += 1;
        else summary.uploaded += 1;
      } catch (error) {
        summary.failed.push({ file: `${teacherName}/${fileName}`, reason: error.message });
      }
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed.length) process.exitCode = 1;
}

await main();
