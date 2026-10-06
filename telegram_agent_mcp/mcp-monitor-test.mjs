import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "telegram-monitor-test", version: "1.0.0" });
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], cwd: process.cwd(), env: process.env });
try {
  await client.connect(transport);
  const status = await client.callTool({ name: "telegram_status", arguments: {} });
  console.log(JSON.stringify(status.content));
} finally {
  await client.close();
}
