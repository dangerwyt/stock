import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(".");
const archive = resolve(process.argv[2] || "../AShare-Handoff-20260907.zip");
const staging = await mkdtemp(join(tmpdir(), "stock-handoff-"));
const files = ["src","worker","scripts","tests","public","docs","db","drizzle","README.md","package.json","package-lock.json","index.html","vite.config.mjs",".env.example","wrangler.example.jsonc"];
for(const file of files) await cp(join(root,file),join(staging,file),{recursive:true});
await mkdir(join(staging,".openai"));
await writeFile(join(staging,".openai/hosting.json"),JSON.stringify({d1:"DB",r2:null},null,2)+"\n");
const revision = execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
await writeFile(join(staging,"SOURCE_REVISION.txt"),revision+"\n");
execFileSync("zip",["-qr",archive,"."],{cwd:staging});
const digest = createHash("sha256").update(await readFile(archive)).digest("hex");
console.log(JSON.stringify({archive,sha256:digest,staging,revision}));
