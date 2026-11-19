#!/usr/bin/env node
import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const cliDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(cliDirectory, "../../..");

function help() {
  process.stdout.write(`CodexDeck CLI

Usage:
  codex-deck start [--port <port>] [--data <path>] [--workspaces <path>]
  codex-deck status [--url <base-url>]
  codex-deck doctor

Options:
  --port <port>          Listening port (default: 3000)
  --data <path>          Persistent application data directory
  --workspaces <path>    Workspace root directory
  --url <base-url>       Server URL for status checks
  -h, --help             Show this help
`);
}

function parseOptions(args) {
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "-h" || name === "--help") {
      values.set("help", "true");
      continue;
    }
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Expected a value after ${name}`);
    if (!["--port", "--data", "--workspaces", "--url"].includes(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    values.set(name.slice(2), value);
  }
  return values;
}

function runCheck(command, args) {
  const file = process.platform === "win32" ? "cmd.exe" : command;
  const commandArgs = process.platform === "win32"
    ? ["/d", "/s", "/c", [command, ...args].join(" ")]
    : args;
  const result = spawnSync(file, commandArgs, {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : null;
}

async function start(options) {
  const port = Number(options.get("port") ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || [22, 80, 443].includes(port)) {
    throw new Error("Port must be between 1 and 65535 and cannot be 22, 80 or 443.");
  }
  const sourceEntry = path.join(repositoryRoot, "apps/server/dist/index.js");
  const bundledEntry = path.join(cliDirectory, "../runtime/apps/server/dist/index.js");
  const bundled = !process.env.CODEXDECK_SERVER_ENTRY && !existsSync(sourceEntry) && existsSync(bundledEntry);
  const entry = process.env.CODEXDECK_SERVER_ENTRY
    ? path.resolve(process.env.CODEXDECK_SERVER_ENTRY)
    : bundled ? bundledEntry : sourceEntry;
  if (!existsSync(entry)) {
    throw new Error("Built server entry not found. Run pnpm build in a CodexDeck checkout or set CODEXDECK_SERVER_ENTRY.");
  }
  const environment = {
    ...process.env,
    CODEXDECK_PORT: String(port),
    CODEXDECK_DATA_DIR: path.resolve(options.get("data") ?? process.env.CODEXDECK_DATA_DIR ?? "./data"),
    CODEXDECK_WORKSPACES: path.resolve(options.get("workspaces") ?? process.env.CODEXDECK_WORKSPACES ?? process.env.CODEXDECK_WORKSPACE_ROOT ?? "./workspaces"),
  };
  const loader = path.resolve(cliDirectory, "../register-loader.mjs");
  const loaderUrl = pathToFileURL(loader).href;
  const childArgs = bundled ? ["--import", loaderUrl, entry] : [entry];
  if (bundled) {
    const loaderOption = `--import="${loaderUrl}"`;
    environment.NODE_OPTIONS = [environment.NODE_OPTIONS, loaderOption].filter(Boolean).join(" ");
  }
  const child = spawn(process.execPath, childArgs, { env: environment, stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  child.once("error", (error) => {
    process.stderr.write(`CodexDeck failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGTERM", forward);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

async function status(options) {
  const base = options.get("url") ?? process.env.CODEXDECK_URL ?? `http://127.0.0.1:${process.env.CODEXDECK_PORT ?? "3000"}`;
  let response;
  try {
    response = await fetch(new URL("/api/health", base), { signal: AbortSignal.timeout(3000) });
    if (response.status === 404) response = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(3000) });
  } catch {
    process.stdout.write(`CodexDeck is unavailable at ${base}\n`);
    process.exitCode = 1;
    return;
  }
  if (!response.ok) {
    process.stdout.write(`CodexDeck returned HTTP ${response.status} at ${base}\n`);
    process.exitCode = 1;
    return;
  }
  const health = await response.json();
  process.stdout.write(`CodexDeck is ${health.status ?? "reachable"} at ${base}`);
  if (health.version) process.stdout.write(` · version ${health.version}`);
  if (typeof health.uptime === "number") process.stdout.write(` · uptime ${Math.floor(health.uptime)}s`);
  process.stdout.write("\n");
}

function doctor() {
  const checks = [
    ["Node.js 22+", Number(process.versions.node.split(".")[0]) >= 22 ? process.version : null],
    ["Codex CLI", runCheck("codex", ["--version"])],
    ["Git", runCheck("git", ["--version"])],
  ];
  let playwright = null;
  const localRequire = createRequire(import.meta.url);
  for (const name of ["playwright", "playwright-core"]) {
    try {
      const resolved = localRequire.resolve(name);
      const { chromium } = localRequire(name);
      playwright = existsSync(resolved)
        ? existsSync(chromium.executablePath()) ? name + " Chromium ready" : name + ", Chromium not installed"
        : null;
      break;
    } catch {}
  }
  checks.push(["Playwright", playwright]);
  const width = Math.max(...checks.map(([name]) => name.length));
  for (const [name, value] of checks) {
    process.stdout.write(`${name.padEnd(width)}  ${value ?? "not found"}\n`);
  }
  if (!checks.slice(0, 3).every(([, value]) => value)) process.exitCode = 1;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
    return;
  }
  const options = parseOptions(args);
  if (options.has("help")) {
    help();
    return;
  }
  if (command === "start") return start(options);
  if (command === "status") return status(options);
  if (command === "doctor") return doctor();
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`Error: ${error.message}\n`);
  process.stderr.write("Run codex-deck --help for usage.\n");
  process.exitCode = 1;
});
