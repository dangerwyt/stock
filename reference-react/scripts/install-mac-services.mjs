import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = process.cwd();
const dir = resolve(homedir(), "Library/LaunchAgents");
mkdirSync(dir, { recursive: true });
mkdirSync(resolve(root, ".local-data/logs"), { recursive: true, mode: 0o700 });
for (const name of [".env", ".env.local", ".env.development.local"]) if (existsSync(name)) chmodSync(name, 0o600);
const escape = text => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
for (const [name, script, schedule] of [
  ["server", "scripts/serve-mac.mjs", "<key>KeepAlive</key><true/>"],
  ["scheduler", "scripts/run-local-scheduler.mjs", "<key>StartInterval</key><integer>60</integer>"],
]) {
  const label = `com.stock-intelligence.${name}`;
  const file = resolve(dir, `${label}.plist`);
  if (existsSync(file)) throw new Error(`Existing service requires explicit update: ${file}`);
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(resolve(root, script))}</string></array>
<key>WorkingDirectory</key><string>${escape(root)}</string>
<key>RunAtLoad</key><true/>${schedule}
<key>EnvironmentVariables</key><dict><key>LOCAL_SCHEDULER_BASE_URL</key><string>http://127.0.0.1:4173</string><key>NODE_ENV</key><string>production</string></dict>
<key>StandardOutPath</key><string>${escape(root)}/.local-data/logs/${name}.log</string>
<key>StandardErrorPath</key><string>${escape(root)}/.local-data/logs/${name}.error.log</string>
</dict></plist>`, { mode: 0o600 });
  console.log(file);
}
