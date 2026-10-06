import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export function codexArgs(replyFile: string, telegramThreadId: string | null, sourceThreadId: string | null): string[] {
  const args = ["exec", "--approve-for-me"];
  if (telegramThreadId) args.push("resume", telegramThreadId);
  else if (sourceThreadId) args.push("fork", sourceThreadId);
  args.push("--skip-git-repo-check", "--json", "--output-last-message", replyFile, "-");
  return args;
}

// Never use cmd.exe to join argv: project paths may contain spaces or shell metacharacters.
export function codexLaunch(args: string[]): { executable: string; args: string[] } {
  if (process.platform !== "win32") return { executable: "codex", args };
  const found = spawnSync("where.exe", ["codex.cmd"], { encoding: "utf8", windowsHide: true });
  for (const shim of (found.stdout ?? "").trim().split(/\r?\n/).filter(Boolean)) {
    const cli = path.join(path.dirname(shim), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(cli)) return { executable: process.execPath, args: [cli, ...args] };
  }
  const native = spawnSync("where.exe", ["codex.exe"], { encoding: "utf8", windowsHide: true });
  const executable = (native.stdout ?? "").trim().split(/\r?\n/).find(file => existsSync(file));
  if (executable) return { executable, args };
  throw new Error("Cannot locate Codex CLI for a shell-free Windows launch. Install @openai/codex or add codex.exe to PATH.");
}
