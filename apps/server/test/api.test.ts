import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { openDatabase, resolveDataDirectory } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { decryptSecret } from "../src/security/crypto.js";

const password = "GeneratedAdminPassword1";
function cookieHeader(cookie: string | string[] | undefined): string {
  return String(Array.isArray(cookie) ? cookie[0] : cookie).split(";")[0];
}

describe("SQLite migrations and admin APIs", () => {
  let workspace: string;
  let data: string;
  let db: Awaited<ReturnType<typeof openDatabase>>;
  let key: Buffer;
  let app: ReturnType<typeof createServer>;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "codexdeck-api-"));
    data = await resolveDataDirectory("data", workspace);
    db = await openDatabase(data, workspace);
    key = randomBytes(32);
    app = createServer({ ...db, masterKey: key, masker: new SecretMasker(), gatewayConfig: parseGatewayConfig() });
  });

  afterEach(async () => {
    await app?.close();
    if (db?.native.open) db.native.close();
    await rm(workspace, { force: true, recursive: true });
  });

  async function setupAdmin() {
    const response = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { password } });
    expect(response.statusCode).toBe(200);
    return { cookie: cookieHeader(response.headers["set-cookie"]) };
  }

  it("cold-starts all twelve core tables, enables WAL and foreign keys, and preserves data on reopening", async () => {
    const expected = ["settings", "providers", "models", "workspaces", "threads", "thread_events", "approvals",
      "artifacts", "deployments", "api_keys", "usage_logs", "notification_channels"];
    const names = db.native.prepare("SELECT name FROM sqlite_master WHERE type='table'").pluck().all();
    expect(names).toEqual(expect.arrayContaining(expected));
    expect(db.native.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.native.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(() => db.native.prepare("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('t','absent','t','ok','now','now')").run())
      .toThrow(/foreign key/i);
    db.native.prepare("INSERT INTO settings VALUES('retained','value','now')").run();
    db.native.close();
    db = await openDatabase(data, workspace);
    expect(db.native.prepare("SELECT value FROM settings WHERE key = 'retained'").pluck().get()).toBe("value");
    expect(db.native.prepare("SELECT COUNT(*) FROM schema_migrations WHERE version=1").pluck().get()).toBe(1);
  });

  it("exposes a small unauthenticated container health document", async () => {
    const health = await app.inject("/api/health");
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok", version: expect.any(String), uptime: expect.any(Number) });
    expect(health.json()).not.toHaveProperty("key");
    expect(health.json()).not.toHaveProperty("database");
  });

  it("handles simultaneous setup atomically, authenticates and revokes a logged-out cookie", async () => {
    expect((await app.inject("/api/providers")).statusCode).toBe(401);
    expect((await app.inject("/api/auth/status")).json()).toMatchObject({ setup_required: true, authenticated: false });
    const passwords = [password, "ConcurrentAdminPassword2"];
    const results = await Promise.all(passwords.map(value =>
      app.inject({ method: "POST", url: "/api/auth/setup", payload: { password: value } })));
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const winner = results.findIndex(result => result.statusCode === 200);
    const loser = 1 - winner;
    expect(results[loser].headers["set-cookie"]).toBeUndefined();
    expect(db.native.prepare("SELECT value FROM settings WHERE key = 'admin_password_hash'").pluck().get()).toMatch(/^scrypt\$/);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: passwords[loser] } })).statusCode).toBe(401);

    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { password: passwords[winner] } });
    expect(login.statusCode).toBe(200);
    expect(login.headers["set-cookie"]).toMatch(/HttpOnly/i);
    expect(login.headers["set-cookie"]).toMatch(/SameSite=Strict/i);
    const headers = { cookie: cookieHeader(login.headers["set-cookie"]) };
    expect((await app.inject({ url: "/api/models", headers })).statusCode).toBe(200);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toMatch(/Max-Age=0/);
    expect((await app.inject({ url: "/api/models", headers })).statusCode).toBe(401);
  });

  it("keeps provider credentials encrypted at rest and retains fields on partial provider and model updates", async () => {
    const headers = await setupAdmin();
    const presets = await app.inject({ url: "/api/providers/presets", headers });
    expect(presets.json().map((p: { id: string }) => p.id).sort())
      .toEqual(["openai_official", "oneapi_newapi", "openrouter", "deepseek", "ollama", "custom"].sort());
    const keyValue = "sk-" + randomBytes(16).toString("hex");
    const headerValue = "custom-header-secret-9876";
    const provider = await app.inject({ method: "POST", url: "/api/providers", headers, payload: {
      name: "Local", preset: "custom", base_url: "http://127.0.0.1:15491/v1", api_key: keyValue,
      headers: { "X-Custom-Auth": headerValue }, quirks: { strip_reasoning: true }, enabled: false,
    } });
    expect(provider.statusCode).toBe(201);
    const id = provider.json().id;
    const url = "/api/providers/" + id;
    const updated = await app.inject({ method: "PATCH", url, headers, payload: { name: "Renamed" } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ name: "Renamed", enabled: false, api_key_masked: "sk-..." + keyValue.slice(-4), quirks: { strip_reasoning: true } });
    const row = db.native.prepare("SELECT * FROM providers WHERE id = ?").get(id) as { api_key_ciphertext: string; headers_json: string };
    expect(decryptSecret(row.api_key_ciphertext, key)).toBe(keyValue);
    expect(JSON.stringify(row)).not.toContain(keyValue);
    expect(row.headers_json).not.toContain(headerValue);
    for (const response of [provider, updated, await app.inject({ url, headers }), await app.inject({ url: "/api/providers", headers })]) {
      expect(response.body).not.toContain(keyValue);
      expect(response.body).not.toContain(headerValue);
      expect(response.body).not.toContain("ciphertext");
    }

    const baseModel = { provider_id: id, model_id: "upstream-a", alias: "local", protocol: "chat",
      enabled: false, cost_input_usd_per_million: 2.5, cost_output_usd_per_million: 9 };
    const model = await app.inject({ method: "POST", url: "/api/models", headers, payload: baseModel });
    expect(model.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/models", headers, payload: baseModel })).statusCode).toBe(409);
    const modelUrl = "/api/models/" + model.json().id;
    const saved = await app.inject({ method: "PATCH", url: modelUrl, headers, payload: { alias: "updated" } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ ...baseModel, alias: "updated" });
    for (const response of [model, saved, await app.inject({ url: modelUrl, headers }), await app.inject({ url: "/api/models", headers })]) {
      expect(response.body).not.toContain(keyValue);
      expect(response.body).not.toContain(headerValue);
    }
    expect((await app.inject({ method: "DELETE", url: modelUrl, headers })).statusCode).toBe(204);
    expect((await app.inject({ url: modelUrl, headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url, headers })).statusCode).toBe(204);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
  });
});
