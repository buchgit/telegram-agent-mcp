import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const packageDir = path.resolve(import.meta.dirname);
const dataDir = path.resolve(packageDir, "data");
const pidFile = path.resolve(dataDir, "monitor-host.pid");
const client = new Client({ name: "telegram-agent-monitor-host", version: "0.4.0" });
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: packageDir,
  env: process.env,
});

let resolveStop;
const stopped = new Promise((resolve) => { resolveStop = resolve; });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => resolveStop());
}

await mkdir(dataDir, { recursive: true });
await writeFile(pidFile, String(process.pid), "utf8");
try {
  await client.connect(transport);
  console.error("telegram-agent standalone monitor host connected");
  await stopped;
} finally {
  await client.close().catch(() => undefined);
  await rm(pidFile, { force: true }).catch(() => undefined);
}

