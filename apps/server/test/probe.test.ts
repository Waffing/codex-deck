import { installationCode } from "../src/routes/auth.js";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer as mockServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { targetPolicy } from "../src/gateway/transport.js";

let native: Database.Database;
let app: ReturnType<typeof createServer>;
let upstream: ReturnType<typeof mockServer>;
let url: string;
let cookie: string;
let handle: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void;
let paths: string[];

beforeEach(async () => {
  native = new Database(":memory:");
  runMigrations(native);
  const key=randomBytes(32);
  app = createServer({ native, orm: drizzle(native, { schema }), masker: new SecretMasker(), masterKey: key,
    gatewayConfig: parseGatewayConfig({ port: 3210 }) });
  const setup = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setup_code: installationCode(native,key), password: "test-admin-password" } });
  cookie = String(setup.headers["set-cookie"]).split(";")[0];
  paths = [];
  upstream = mockServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    paths.push(req.url!);
    handle(req, res, data ? JSON.parse(data) : {});
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  url = "http://127.0.0.1:" + (upstream.address() as AddressInfo).port;
});
afterEach(async () => {
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
  native.close();
});

async function createProvider(base_url: string) {
  const created = await app.inject({ method: "POST", url: "/api/providers", headers: { cookie },
    payload: { name: "test upstream", preset: "custom", base_url, api_key: "sk-probe-fixture-only" } });
  expect(created.statusCode).toBe(201);
  return created.json().id as string;
}
const probe = (id: string) => app.inject({ method: "POST", url: "/api/providers/" + id + "/probe", headers: { cookie } });

test("discovers models and measures the first text delta after metadata and heartbeat, then persists verified features", async () => {
  const seenModels: unknown[] = [];
  handle = (req, res, body) => {
    if (req.headers.authorization !== "Bearer sk-probe-fixture-only") { res.writeHead(401).end(); return; }
    if (req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "discovered-model" }] })); return; }
    seenModels.push(body.model);
    if (req.url !== "/v1/responses") { res.writeHead(404).end(); return; }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(': ping\n\ndata: {"type":"response.created"}\n\n');
      setTimeout(() => res.end('data: {"type":"response.output_text.delta","delta":"OK"}\n\n'), 50);
    } else res.end(JSON.stringify({ output: body.tools
      ? [{ type: "function_call", name: "ping", arguments: "{}" }]
      : [{ type: "message", content: [{ type: "output_text", text: "red" }] }] }));
  };
  const id = await createProvider(url);
  const result = (await probe(id)).json();
  expect(result).toMatchObject({ ok: true, models: ["discovered-model"], capabilities: { responses: true, chat: false, tools: true, vision: true } });
  expect(result.capabilities.latency_ms).toBeGreaterThanOrEqual(45);
  expect(new Set(seenModels)).toEqual(new Set(["discovered-model"]));
  const stored = native.prepare("SELECT last_probe_json FROM providers WHERE id=?").pluck().get(id);
  expect(JSON.parse(String(stored))).toEqual(result);
  expect((await app.inject({ url: "/api/providers/" + id, headers: { cookie } })).json().last_probe).toEqual(result);
});

test("continues with the bound model after discovery fails and rejects features ignored by a chat relay", async () => {
  const seenModels: unknown[] = [];
  handle = (req, res, body) => {
    if (req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
    seenModels.push(body.model);
    if (body.stream) res.writeHead(200, { "content-type": "text/event-stream" })
      .end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
    else res.end(JSON.stringify({ choices: [{ message: { content: "unsupported" } }] }));
  };
  const id = await createProvider(url + "/v1/");
  const first=await app.inject({ method: "POST", url: "/api/models", headers: { cookie },
    payload: { alias: "test-alias", model_id: "bound-model", provider_id: id } });
  const result = (await probe(id)).json();
  expect(result).toMatchObject({ ok: true, models: [], capabilities: { responses: false, chat: true, tools: false, vision: false } });
  expect(new Set(seenModels)).toEqual(new Set(["bound-model"]));
  const second=await app.inject({method:"POST",url:"/api/models",headers:{cookie},payload:{alias:"other",model_id:"other",provider_id:id}});
  handle=(_req,res)=>res.writeHead(401).end();
  const other=await app.inject({method:"POST",url:`/api/providers/${id}/probe`,headers:{cookie},payload:{model_id:second.json().id}});
  expect(other.json()).toMatchObject({ok:false,error:expect.stringContaining("401")});
  expect((await app.inject({url:`/api/models/${first.json().id}`,headers:{cookie}})).json().last_probe.ok).toBe(true);
  expect((await app.inject({url:`/api/models/${second.json().id}`,headers:{cookie}})).json().last_probe.ok).toBe(false);
});

test("accepts public TLS provider presets and protects local and mapped loopback endpoints",()=>{
  for(const name of ["api.openai.com","openrouter.ai","api.deepseek.com"]) expect(targetPolicy(new URL("https://"+name),true,[3210])).toBeTruthy();
  for(const host of ["localhost","127.0.0.1","[::1]","[::ffff:7f00:0001]"]) expect(()=>targetPolicy(new URL("https://"+host),true,[3210])).toThrow(/protected/);
});

test("refuses protected ports and the actual listening port, and never follows upstream redirects", async () => {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  for (const base of [address, "http://127.0.0.1:22", "http://127.0.0.1", "https://127.0.0.1", "http://127.0.0.1:3210"]) {
    expect((await probe(await createProvider(base))).json()).toMatchObject({ ok: false, error: expect.stringContaining("protected port") });
  }
  handle = (_req, res) => { res.writeHead(302, { location: url + "/redirected" }).end(); };
  expect((await probe(await createProvider(url))).json().ok).toBe(false);
  expect(paths).not.toContain("/redirected");
});
