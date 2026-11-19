import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type Database from "better-sqlite3";
import { gatewayConfigSchema } from "@codexdeck/shared";
import { signPayload, createInternalToken } from "../security/crypto.js";
import { repositoryRoot, workspaceDirectory, workspaceFile } from "../security/paths.js";
import { SecretMasker } from "../security/secret-masker.js";
import { readCredentials } from "../gateway/credentials.js";

interface ConfigOptions {
  workspaceRoot?: string;
  dataDirectory: string;
  native: Database.Database;
  masterKey: Uint8Array;
  port: number;
  defaultModel?: string;
  tokenTtlSeconds?: number;
  thread?: { id: string; home?: string | null; opsEntry: string; globalInstructions: string };
}

/** The returned env is a complete child environment. Do not merge process.env into it. */
export async function generateCodexConfig(options: ConfigOptions) {
  const { port, internal_token_ttl_seconds: ttl } = gatewayConfigSchema.parse({
    port: options.port, internal_token_ttl_seconds: options.tokenTtlSeconds,
  });
  if ([22, 80, 443].includes(port)) throw new Error("Invalid internal gateway port.");
  const configured = options.native.prepare("SELECT value FROM settings WHERE key = 'default_model'")
    .get() as { value: string } | undefined;
  const preferred = options.defaultModel ?? configured?.value ?? null;
  const model = options.native.prepare(`SELECT m.alias FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.enabled = 1 AND p.enabled = 1 AND (? IS NULL OR m.alias = ?)
    ORDER BY m.created_at, m.id LIMIT 1`).get(preferred, preferred) as { alias: string } | undefined;
  if (!model) throw new Error("Configure an enabled default model and provider before generating Codex configuration.");

  const root = options.workspaceRoot ?? repositoryRoot;
  const dataRoot = path.isAbsolute(options.dataDirectory) ? path.dirname(options.dataDirectory) : root;
  const base = await workspaceDirectory(dataRoot, options.dataDirectory);
  const alias = model.alias;
  const masker = new SecretMasker();
  const context = { masker, masterKey: Buffer.from(options.masterKey) };
  const stored = options.native.prepare("SELECT api_key_ciphertext AS apiKeyCiphertext, headers_json AS headersJson FROM providers")
    .all() as Parameters<typeof readCredentials>[0][];
  for (const provider of stored) readCredentials(provider, context);
  if (masker.maskString(alias) !== alias || masker.maskString(base) !== base) {
    throw new Error("The model alias or Codex home path contains a credential.");
  }
  const relativeHome = options.thread?.home ? path.relative(base, path.resolve(options.thread.home)) : "";
  if (relativeHome && (relativeHome === ".." || relativeHome.startsWith(".." + path.sep) || path.isAbsolute(relativeHome))) {
    throw new Error("Codex home must stay inside the data directory.");
  }
  const codexHome = options.thread?.home
    ? await workspaceDirectory(base, relativeHome)
    : await workspaceDirectory(dataRoot, await mkdtemp(path.join(base, "codex-home-")));
  const catalogPath = await workspaceFile(dataRoot, path.join(codexHome, "models.json"));
  const baseUrl = `http://127.0.0.1:${port}/internal/v1`;
  const catalog = { models: [{
    slug: alias,
    display_name: alias,
    description: "CodexDeck gateway model",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 1,
    base_instructions: "You are a coding assistant.",
    supports_reasoning_summaries: false,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ["text"],
  }] };
  // JSON-quoted strings escape Windows paths, quotes and newlines in TOML basic strings.
  const toml = [
    `model = ${JSON.stringify(alias)}`,
    'model_provider = "codexdeck"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "",
    ...(options.thread ? [
      'sandbox_mode = "workspace-write"', 'approval_policy = "on-request"',
      '[shell_environment_policy]', 'inherit = "core"',
      'exclude = ["*TOKEN*", "*KEY*", "CODEX_HOME", "CODEXDECK_*"]',
      '[mcp_servers.codexdeck_ops]', "command = " + JSON.stringify(process.execPath),
      "args = [" + JSON.stringify(options.thread.opsEntry) + "]",
      'env_vars = ["CODEXDECK_OPS_TOKEN", "CODEXDECK_OPS_URL"]',
    ] : []),
    "[model_providers.codexdeck]",
    'name = "CodexDeck"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    'wire_api = "responses"',
    'env_key = "CODEXDECK_INTERNAL_TOKEN"',
    "",
  ].join("\n");
  const flag = options.thread?.home ? "w" : "wx";
  await writeFile(catalogPath, JSON.stringify(catalog, null, 2), { flag, mode: 0o600 });
  await writeFile(await workspaceFile(dataRoot, path.join(codexHome, "config.toml")), toml, { flag, mode: 0o600 });
  const env: { CODEX_HOME: string; CODEXDECK_INTERNAL_TOKEN: string; [key: string]: string } = {
    CODEX_HOME: codexHome, CODEXDECK_INTERNAL_TOKEN: createInternalToken(options.masterKey, ttl, options.thread?.id),
  };
  if (options.thread) {
    // Supply runtime paths explicitly. Never inherit the host environment.
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const runtimeEnv: Record<string,string> = process.platform === "win32"
      ? { SystemRoot:systemRoot, PATH:[path.dirname(process.execPath),path.join(systemRoot,"System32"),
        path.join(process.env.ProgramFiles ?? "C:\\Program Files","Git","cmd")].join(path.delimiter), TEMP:os.tmpdir(), TMP:os.tmpdir() }
      : { PATH:[path.dirname(process.execPath),"/usr/local/bin","/usr/bin","/bin"].join(path.delimiter), TMPDIR:os.tmpdir() };
    for (const [name,value] of Object.entries(runtimeEnv)) {
      if (masker.maskString(value) !== value) throw new Error("Credential detected in system path.");
      env[name] = value;
    }
    const now = Math.floor(Date.now()/1000);
    env.CODEXDECK_OPS_URL = "http://127.0.0.1:" + port + "/internal/ops";
    env.CODEXDECK_OPS_TOKEN = signPayload({ aud: "codexdeck-ops", thread_id: options.thread.id, iat: now, exp: now + ttl }, options.masterKey);
    await writeFile(await workspaceFile(dataRoot, path.join(codexHome, "AGENTS.md")), masker.maskString(options.thread.globalInstructions),
      { flag, mode: 0o600 });
  }
  return { codexHome, baseUrl, alias, env };
}
