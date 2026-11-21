import { listenHttpFixture } from "./fixtures/http-port.js";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase, readOrCreateFileKey, resolveDataDirectory } from "../src/db/index.js";
import { generateCodexConfig } from "../src/codex/config-gen.js";
import { smoke } from "../src/codex/smoke.js";
import { encryptSecret, verifyInternalToken } from "../src/security/crypto.js";

let fixture: string;
let root: string;
beforeEach(async () => {
  fixture = await mkdtemp(path.join(tmpdir(), "codexdeck-config-"));
  root = path.join(fixture, "workspace");
  await mkdir(root);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixture, { recursive: true, force: true });
});

it("refuses parent traversal, an escaping junction and SQLite auxiliary-file links before opening storage", async () => {
  const external = path.join(fixture, "external");
  await mkdir(external);
  await symlink(external, path.join(root, "link"), "junction");
  await expect(resolveDataDirectory(".", root)).rejects.toThrow(/inside/);
  await expect(resolveDataDirectory("../external/data", root)).rejects.toThrow(/inside/);
  await expect(resolveDataDirectory("link/nested/new", root)).rejects.toThrow(/inside/);
  const data = await resolveDataDirectory("safe", root);
  await symlink(external, path.join(data, "codexdeck.sqlite-wal"), "junction");
  await expect(openDatabase(data, root)).rejects.toThrow(/regular/);
  await symlink(external, path.join(data, "master.key"), "junction");
  await expect(readOrCreateFileKey(data, root)).rejects.toThrow(/regular/);
  expect(await readdir(external)).toEqual([]);
});

it("stores absolute data directories outside the workspace root while resolving their real path", async () => {
  const external = path.join(fixture, "persistent-data");
  const data = await resolveDataDirectory(external, root);
  expect(data).toBe(await realpath(external));
  const database = await openDatabase(data, root);
  expect(database.native.pragma("journal_mode", { simple: true })).toBe("wal");
  await readOrCreateFileKey(data, root);
  expect(await readdir(data)).toContain("master.key");
  database.native.close();
});

it("publishes exactly one complete and stable development master key across overlapping starts", async () => {
  const data = await resolveDataDirectory("keys", root);
  const keys = await Promise.all(Array.from({ length: 8 }, () => readOrCreateFileKey(data, root)));
  expect(new Set(keys.map(key => key.toString("hex"))).size).toBe(1);
  expect(await readOrCreateFileKey(data, root)).toEqual(keys[0]);
  expect(await readdir(data)).toEqual(["master.key"]);
  vi.stubEnv("NODE_ENV", "production");
  await expect(readOrCreateFileKey(data, root)).rejects.toThrow(/CODEXDECK_MASTER_KEY/);
});

it("generates isolated Codex homes, selects the configured alias and runs a signed HTTP smoke request", async () => {
  const dataDirectory = await resolveDataDirectory("data", root);
  const { native } = await openDatabase(dataDirectory, root);
  const masterKey = randomBytes(32);
  const secret = "sk-test-example-provider-1234";
  vi.stubEnv("AN_ARBITRARY_PROVIDER_SECRET", secret);
  vi.stubEnv("OPENAI_API_KEY", secret);
  let received = false;
  const gateway = createServer(async (req, res) => {
    const body: Buffer[] = [];
    for await (const chunk of req) body.push(chunk);
    const token = (req.headers.authorization ?? "").slice(7);
    received = req.url === "/internal/v1/responses" && req.method === "POST" &&
      verifyInternalToken(token, masterKey) && JSON.parse(Buffer.concat(body).toString()).model === "preferred";
    res.writeHead(received ? 200 : 401, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "response", status: "completed", output: [] }));
  });
  try {
    const port=await listenHttpFixture(gateway);
    const options = { native, workspaceRoot: root, dataDirectory, masterKey, port };
    await expect(generateCodexConfig(options)).rejects.toThrow(/enabled default/);
    native.exec(`INSERT INTO providers(id, name, preset, base_url, headers_json, quirks_json, enabled, created_at, updated_at)
      VALUES ('p', 'sample', 'custom', 'http://127.0.0.1:19001/v1', '{}', '{}', 1, '', '');
      INSERT INTO models(id, provider_id, alias, model_id, created_at, updated_at)
      VALUES ('m1','p','other','remote-model-1','1',''), ('m2','p','preferred','remote-model-2','2','');
      INSERT INTO settings(key, value, updated_at) VALUES ('default_model', 'preferred', '')`);
    const config = await generateCodexConfig(options);
    const another = await generateCodexConfig(options);
    expect(config.codexHome).not.toBe(another.codexHome);
    expect(Object.keys(config.env).sort()).toEqual(["CODEXDECK_INTERNAL_TOKEN", "CODEX_HOME"]);
    const toml = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
    const catalog = await readFile(path.join(config.codexHome, "models.json"), "utf8");
    expect(toml).toContain('model = "preferred"');
    expect(toml).toContain('[model_providers.codexdeck]');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('env_key = "CODEXDECK_INTERNAL_TOKEN"');
    expect(toml).toContain("model_catalog_json = " + JSON.stringify(path.join(config.codexHome, "models.json")));
    expect(toml).toContain(`http://127.0.0.1:${port}/internal/v1`);
    expect(JSON.parse(catalog).models[0].slug).toBe("preferred");
    expect(JSON.parse(catalog).models[0].context_window).toBe(128000);
    expect(JSON.parse(catalog).models[0].supports_reasoning_summaries).toBe(false);
    const readSummarySupport=async()=>{
      const config=await generateCodexConfig(options);
      const catalog=JSON.parse(await readFile(path.join(config.codexHome,"models.json"),"utf8"));
      return catalog.models[0].supports_reasoning_summaries;
    };
    native.exec(`UPDATE models SET protocol='responses',capabilities_json='["reasoning_summary"]' WHERE alias='preferred'`);
    expect(await readSummarySupport()).toBe(true);
    native.exec(`UPDATE providers SET quirks_json='{"strip_reasoning":true}' WHERE id='p'`);
    expect(await readSummarySupport()).toBe(false);
    native.exec(`UPDATE providers SET quirks_json='{}' WHERE id='p'; UPDATE models SET protocol='chat' WHERE alias='preferred'`);
    expect(await readSummarySupport()).toBe(false);
    expect(toml).toContain("model_context_window = 128000");
    expect(toml + catalog).not.toContain(config.env.CODEXDECK_INTERNAL_TOKEN);
    expect(toml + catalog + JSON.stringify(config.env)).not.toContain(secret);
    await smoke(config);
    expect(received).toBe(true);
    const opaqueKey = "providerCredentialWithoutAPrefix";
    native.prepare("UPDATE providers SET api_key_ciphertext = ? WHERE id = 'p'").run(encryptSecret(opaqueKey, masterKey));
    native.prepare("UPDATE models SET alias = ? WHERE id = 'm1'").run(opaqueKey);
    await expect(generateCodexConfig({ ...options, defaultModel: opaqueKey })).rejects.toThrow(/contains a credential/);
    const secondary="fixture-only-another-provider-key";
    native.prepare("UPDATE providers SET api_keys_enc=? WHERE id='p'").run(encryptSecret(JSON.stringify([{id:"one",value:opaqueKey},{id:"two",value:secondary}]),masterKey));
    for(const candidate of [secondary,"fixture-control-plane-credential"]) {
      native.prepare("UPDATE providers SET balance_token_enc=? WHERE id='p'").run(encryptSecret("fixture-control-plane-credential",masterKey));
      native.prepare("UPDATE models SET alias=? WHERE id='m1'").run(candidate);
      await expect(generateCodexConfig({...options,defaultModel:candidate})).rejects.toThrow(/contains a credential/);
    }
  } finally {
    native.close();
    if (gateway.listening) await new Promise<void>(resolve => gateway.close(() => resolve()));
  }
});
