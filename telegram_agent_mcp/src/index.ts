import { spawn } from "node:child_process";
import { open, readFile, mkdir, writeFile, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { extractCommand } from "./command.js";
import { codexLaunch, codexArgs } from "./codex-launch.js";

type TelegramMessage = {
  chat?: { id: number | string };
  text?: string;
  from?: { id?: number | string; username?: string };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

type State = { nextOffset: number };

type AgentSessionState = {
  threadId?: string;
  commandPrefix?: string;
};

type MonitorConfig = {
  enabled: boolean;
  token: string;
  chatId: string;
  usePrefixFilter: boolean;
  prefix: string;
  pollTimeout: number;
  stateFile: string;
};

const packageDir = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(packageDir, "..");
const envPath = path.resolve(packageDir, ".env");
const dataDir = path.resolve(packageDir, "data");
const monitorLockFile = path.resolve(dataDir, "monitor.lock");
const agentSessionFile = path.resolve(dataDir, "telegram-agent-session.json");

dotenv.config({ path: envPath });

const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
const usePrefixFilter = (process.env.TELEGRAM_USE_PREFIX_FILTER ?? "true").toLowerCase() === "true";
const prefix = process.env.TELEGRAM_COMMAND_PREFIX ?? "cod";
const stateFile = resolvePackagePath(process.env.TELEGRAM_STATE_FILE, "data/state.json");
const monitorEnabled = (process.env.TELEGRAM_MONITOR_ENABLED ?? "false").toLowerCase() === "true";

let monitorState: "disabled" | "starting" | "running" | "standby" | "stopped" | "error" = monitorEnabled ? "starting" : "disabled";
let monitorLastError: string | null = null;
let monitorLock: FileHandle | null = null;
let shuttingDown = false;

function resolvePackagePath(value: string | undefined, fallback: string): string {
  const selected = value?.trim() || fallback;
  return path.isAbsolute(selected) ? selected : path.resolve(packageDir, selected);
}

async function loadToken(): Promise<string> {
  const values = dotenv.parse(await readFile(envPath));
  const token = values.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required in .env");
  return token;
}

async function readState(filePath: string): Promise<State> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as State;
  } catch {
    return { nextOffset: 0 };
  }
}

async function writeState(filePath: string, state: State): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

async function telegramApi<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const telegramTimeout = typeof body?.timeout === "number" ? body.timeout : 0;
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout((telegramTimeout + 15) * 1000),
  });
  const result = await response.json() as { ok: boolean; result?: T; description?: string };
  if (!response.ok || !result.ok) throw new Error(`Telegram API ${method} failed: ${result.description ?? response.statusText}`);
  return result.result as T;
}

async function api<T>(method: string, body?: Record<string, unknown>): Promise<T> {
  return telegramApi<T>(await loadToken(), method, body);
}

function messageOf(update: TelegramUpdate): TelegramMessage | undefined {
  return update.message ?? update.channel_post;
}

async function loadMonitorConfig(): Promise<MonitorConfig> {
  const values = dotenv.parse(await readFile(envPath));
  const pollTimeoutRaw = Number.parseInt(values.TELEGRAM_MONITOR_POLL_TIMEOUT ?? "30", 10);
  return {
    enabled: (values.TELEGRAM_MONITOR_ENABLED ?? "true").toLowerCase() === "true",
    token: values.TELEGRAM_BOT_TOKEN?.trim() ?? "",
    chatId: values.TELEGRAM_CHAT_ID?.trim() ?? "",
    usePrefixFilter: (values.TELEGRAM_USE_PREFIX_FILTER ?? "true").toLowerCase() === "true",
    prefix: values.TELEGRAM_COMMAND_PREFIX?.trim() ?? "cod",
    pollTimeout: Number.isFinite(pollTimeoutRaw) ? Math.min(50, Math.max(1, pollTimeoutRaw)) : 30,
    stateFile: resolvePackagePath(values.TELEGRAM_MONITOR_STATE_FILE, "data/monitor-state.json"),
  };
}

async function sendTelegramText(config: MonitorConfig, text: string): Promise<void> {
  let remaining = text.trim();
  while (remaining.length > 0) {
    const part = remaining.slice(0, 3500);
    remaining = remaining.slice(3500);
    await telegramApi(config.token, "sendMessage", { chat_id: config.chatId, text: part });
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function acquireMonitorLock(): Promise<FileHandle | null> {
  await mkdir(dataDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(monitorLockFile, "wx");
      await handle.writeFile(String(process.pid), "utf8");
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingPid = Number.parseInt((await readFile(monitorLockFile, "utf8").catch(() => "0")).trim(), 10);
      if (Number.isFinite(existingPid) && processExists(existingPid)) return null;
      await rm(monitorLockFile, { force: true });
    }
  }
  return null;
}

async function releaseMonitorLock(): Promise<void> {
  if (!monitorLock) return;
  await monitorLock.close().catch(() => undefined);
  monitorLock = null;
  await rm(monitorLockFile, { force: true }).catch(() => undefined);
}

async function readTelegramAgentThread(commandPrefix: string): Promise<string | null> {
  try {
    const state = JSON.parse(await readFile(agentSessionFile, "utf8")) as AgentSessionState;
    if (state.commandPrefix !== commandPrefix) {
      console.error(`telegram agent session reset: command prefix changed from ${JSON.stringify(state.commandPrefix ?? null)} to ${JSON.stringify(commandPrefix)}`);
      await rm(agentSessionFile, { force: true });
      return null;
    }
    return state.threadId?.trim() || null;
  } catch {
    return null;
  }
}

async function runCodexCommand(command: string, sender: string, commandPrefix: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const replyFile = path.resolve(dataDir, `agent-reply-${process.pid}-${Date.now()}.txt`);
  const telegramThreadId = await readTelegramAgentThread(commandPrefix);
  const sourceThreadId = process.env.CODEX_THREAD_ID?.trim() || null;
  const prompt = [
    "An authorized command was received from the configured Telegram chat.",
    "Treat the command body below exactly as a user message entered for this project.",
    "Do not call telegram_read_commands for this event; the embedded monitor already consumed it.",
    "The bridge sends your final response to Telegram automatically.",
    "Use telegram_send_message only for intermediate progress when existing user instructions require it.",
    "Apply all normal safety and approval rules.",
    "",
    `Telegram sender: ${sender}`,
    "Command body:",
    command,
  ].join("\n");

  const args = codexArgs(replyFile, telegramThreadId, sourceThreadId);
  const launch = codexLaunch(args);
  const child = spawn(launch.executable, launch.args, {
    cwd: projectRoot,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let diagnostics = "";
  let stdoutBuffer = "";
  let startedThreadId: string | null = null;
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    diagnostics = (diagnostics + text).slice(-8000);
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { type?: string; thread_id?: string };
        if (event.type === "thread.started" && event.thread_id) startedThreadId = event.thread_id;
      } catch {
        // Diagnostics can contain non-JSON lines from child integrations.
      }
    }
  });
  child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-8000); });
  child.stdin.end(prompt, "utf8");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  try {
    if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}: ${diagnostics.trim()}`);
    if (startedThreadId) {
      const agentSession: AgentSessionState = { threadId: startedThreadId, commandPrefix };
      await writeFile(agentSessionFile, JSON.stringify(agentSession, null, 2) + "\n", "utf8");
    }
    const reply = (await readFile(replyFile, "utf8")).trim();
    return reply || "Команда выполнена без текстового ответа.";
  } finally {
    await rm(replyFile, { force: true }).catch(() => undefined);
  }
}

async function startMonitor(): Promise<void> {
  monitorLock = await acquireMonitorLock();
  if (!monitorLock) {
    monitorState = "standby";
    console.error("telegram monitor standby: another MCP process owns incoming updates");
    return;
  }

  monitorState = "running";
  console.error("telegram monitor running");

  let initializedStateFile: string | null = null;
  let observedPrefix: string | null = null;
  let offset = 0;

  while (!shuttingDown) {
    try {
      const config = await loadMonitorConfig();
      if (!config.enabled) {
        monitorState = "stopped";
        break;
      }
      if (!config.token || !config.chatId) throw new Error("Telegram token and chat ID are required for the monitor");
      if (config.usePrefixFilter && !config.prefix) throw new Error("Telegram command prefix cannot be empty while filtering is enabled");

      if (observedPrefix !== null && observedPrefix !== config.prefix) {
        await rm(agentSessionFile, { force: true });
        console.error(`telegram agent session reset: command prefix changed from ${JSON.stringify(observedPrefix)} to ${JSON.stringify(config.prefix)}`);
      }
      observedPrefix = config.prefix;

      if (initializedStateFile !== config.stateFile) {
        const state = await readState(config.stateFile);
        offset = state.nextOffset;
        if (offset === 0) {
          const latest = await telegramApi<TelegramUpdate[]>(config.token, "getUpdates", {
            offset: -1,
            limit: 1,
            timeout: 0,
            allowed_updates: ["message", "channel_post"],
          });
          if (latest.length > 0) offset = latest.at(-1)!.update_id + 1;
          await writeState(config.stateFile, { nextOffset: offset });
        }
        initializedStateFile = config.stateFile;
      }

      const updates = await telegramApi<TelegramUpdate[]>(config.token, "getUpdates", {
        offset,
        limit: 20,
        timeout: config.pollTimeout,
        allowed_updates: ["message", "channel_post"],
      });

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await writeState(config.stateFile, { nextOffset: offset });

        const message = messageOf(update);
        const text = message?.text ?? "";
        if (String(message?.chat?.id) !== config.chatId || !text) continue;
        const command = extractCommand(text, config.usePrefixFilter, config.prefix);
        if (command === null) continue;
        if (!command) {
          await sendTelegramText(config, `После префикса «${config.prefix}» нет команды.`);
          continue;
        }

        const sender = message?.from?.username ?? String(message?.from?.id ?? "unknown");
        console.error(`[telegram] ${new Date().toISOString()} command received from ${sender}: ${command}`);
        await sendTelegramText(config, "Команда принята. Передаю агенту.");
        try {
          const reply = await runCodexCommand(command, sender, config.prefix);
          await sendTelegramText(config, reply);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          monitorLastError = detail;
          console.error(`telegram command failed: ${detail}`);
          await sendTelegramText(config, `Не удалось выполнить команду агентом: ${detail.slice(0, 3000)}`);
        }
      }

      monitorLastError = null;
    } catch (error) {
      if (shuttingDown) break;
      monitorState = "error";
      monitorLastError = error instanceof Error ? error.message : String(error);
      console.error(`telegram monitor error: ${monitorLastError}`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      monitorState = "running";
    }
  }

  await releaseMonitorLock();
}

const server = new McpServer({ name: "telegram-agent", version: "0.4.0" });

server.tool("telegram_status", "Check the configured bot, target chat, filter and embedded monitor.", {}, async () => {
  const config = await loadMonitorConfig();
  if (!config.chatId) throw new Error("TELEGRAM_CHAT_ID is required in .env");
  const me = await telegramApi<{ id: number; username?: string }>(config.token, "getMe");
  const chat = await telegramApi<{ id: number | string; type: string; title?: string; username?: string }>(config.token, "getChat", { chat_id: config.chatId });
  return { content: [{ type: "text", text: JSON.stringify({ bot: me, chat, usePrefixFilter: config.usePrefixFilter, prefix: config.prefix, monitorEnabled: config.enabled, monitorState, monitorLastError }) }] };
});

server.tool(
  "telegram_read_commands",
  "Read new Telegram messages when the embedded monitor is disabled. The monitor owns incoming updates when enabled.",
  { limit: z.number().int().min(1).max(100).default(20) },
  async ({ limit }) => {
    const config = await loadMonitorConfig();
    if (!config.chatId) throw new Error("TELEGRAM_CHAT_ID is required in .env");
    if (config.enabled) throw new Error("telegram_read_commands is disabled because the embedded monitor owns incoming updates");
    const currentStateFile = resolvePackagePath((dotenv.parse(await readFile(envPath))).TELEGRAM_STATE_FILE, "data/state.json");
    const state = await readState(currentStateFile);
    const updates = await api<TelegramUpdate[]>("getUpdates", {
      offset: state.nextOffset,
      limit,
      timeout: 0,
      allowed_updates: ["message", "channel_post"],
    });
    let nextOffset = state.nextOffset;
    const commands: Array<Record<string, unknown>> = [];
    for (const update of updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      const message = messageOf(update);
      const text = message?.text ?? "";
      if (String(message?.chat?.id) !== config.chatId) continue;
      const command = extractCommand(text, config.usePrefixFilter, config.prefix);
      if (command === null) continue;
      commands.push({ updateId: update.update_id, chatId: config.chatId, text, command, from: message?.from?.username ?? null });
    }
    await writeState(currentStateFile, { nextOffset });
    return { content: [{ type: "text", text: JSON.stringify({ count: commands.length, commands }) }] };
  },
);

server.tool(
  "telegram_send_message",
  "Send a progress update or response to the configured Telegram chat.",
  { text: z.string().min(1).max(3500) },
  async ({ text }) => {
    const config = await loadMonitorConfig();
    if (!config.chatId) throw new Error("TELEGRAM_CHAT_ID is required in .env");
    const sent = await telegramApi<{ message_id: number; chat: { id: number | string }; from?: { username?: string } }>(config.token, "sendMessage", { chat_id: config.chatId, text });
    return { content: [{ type: "text", text: JSON.stringify({ messageId: sent.message_id, chatId: sent.chat.id, from: sent.from?.username ?? null }) }] };
  },
);

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await releaseMonitorLock();
}

process.once("SIGINT", () => { void shutdown().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });
process.stdin.once("end", () => { void shutdown(); });

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`telegram-agent MCP ready; chat=${chatId}; prefix=${prefix}; monitor=${monitorEnabled}`);

if (monitorEnabled) {
  void startMonitor().catch((error) => {
    monitorState = "error";
    monitorLastError = error instanceof Error ? error.message : String(error);
    console.error(`telegram monitor stopped: ${monitorLastError}`);
  });
}
