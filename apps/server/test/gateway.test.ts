import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createServer, parseGatewayConfig, type ServerContext } from "../src/app.js";
import { models, providers, schema, usageLogs } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";
import { createInternalToken, encryptSecret, signPayload } from "../src/security/crypto.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { sealHeaders } from "../src/gateway/credentials.js";
import { readSse } from "../src/gateway/sse.js";

const upstreamKey = "fixture.opaque-provider-passphrase";
const tenantKey = "fixture-private-tenant";
const usage = { input_tokens: 20, output_tokens: 7, total_tokens: 27 };
const nativeResult = { id: "resp_fixed", object: "response", status: "completed", model: "real-native", output: [], usage };
const nativeStream = ": service heartbeat\r\n\r\n"
  + "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\n"
  + "event: response.completed\r\ndata: " + JSON.stringify({ type: "response.completed", response: nativeResult }) + "\r\n\r\n";

type Upstream = (body: Record<string, any>, response: ServerResponse, path: string) => void;
let observed: { headers: IncomingHttpHeaders; path: string; body: Record<string, any> }[];
let context: ServerContext;
let app: ReturnType<typeof createServer>;
let mock: ReturnType<typeof createHttpServer>;
let serve: Upstream;
let url: string;
let mockUrl: string;
let token: string;

beforeEach(async () => {
  const native = new Database(":memory:");
  runMigrations(native);
  context = {
    native, orm: drizzle(native, { schema }), masterKey: randomBytes(32), masker: new SecretMasker(),
    gatewayConfig: parseGatewayConfig({ port: 43210, upstream_timeout_ms: 1000 }),
  };
  token = createInternalToken(context.masterKey);
  observed = [];
  serve = (_body, res) => res.writeHead(500).end();
  mock = createHttpServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    observed.push({ headers: req.headers, path: req.url!, body });
    serve(body, res, req.url!);
  });
  mock.listen(0, "127.0.0.1");
  await once(mock, "listening");
  mockUrl = "http://127.0.0.1:" + (mock.address() as AddressInfo).port + "/v1";
  app = createServer(context);
  url = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterEach(async () => {
  await app.close();
  mock.closeAllConnections();
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  context.native.close();
});

function addModel(alias: string, protocol: string, fallbacks: string[] = []) {
  const now = new Date().toISOString();
  context.orm.insert(providers).values({
    id: "p-" + alias, name: alias, preset: "custom", baseUrl: mockUrl, enabled: true,
    apiKeyCiphertext: encryptSecret(upstreamKey, context.masterKey), headersJson: sealHeaders({ "x-tenant": tenantKey }, context),
    quirksJson: JSON.stringify({ strip_reasoning: true }), createdAt: now, updatedAt: now,
  }).run();
  context.orm.insert(models).values({
    id: alias, alias, providerId: "p-" + alias, modelId: "real-" + alias, protocol, enabled: true,
    fallbackModelIdsJson: JSON.stringify(fallbacks), costInputUsdPerMillion: 2, costOutputUsdPerMillion: 5,
    createdAt: now, updatedAt: now,
  }).run();
}

function post(model: string, extra: Record<string, unknown> = {}, bearer = token) {
  return fetch(url + "/internal/v1/responses", {
    method: "POST", body: JSON.stringify({ model, input: "hello", ...extra }),
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
  });
}

function chatData(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\n\n";
}

async function jsonEvents(response: Response) {
  const events = [];
  for await (const frame of readSse(response.body!)) if (frame.data) events.push(JSON.parse(frame.data));
  return events;
}

test("rejects missing, expired and wrong-audience credentials before contacting an upstream", async () => {
  addModel("native", "responses");
  const missing = await fetch(url + "/internal/v1/responses", { method: "POST" });
  expect(missing.status).toBe(401);
  expect((await post("native", {}, createInternalToken(context.masterKey, -1))).status).toBe(401);
  const now = Math.floor(Date.now() / 1000);
  expect((await post("native", {}, signPayload({ aud: "codexdeck-session", iat: now, exp: now + 60, nonce: "fixture" }, context.masterKey))).status).toBe(401);
  expect((await post("native", {}, "bad-signature")).status).toBe(401);
  expect(observed).toHaveLength(0);
});

test("forwards native JSON and preserves raw SSE including comments, CRLF and UTF-8", async () => {
  addModel("native", "responses");
  serve = (request, res) => {
    if (!request.stream) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(nativeResult));
    else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from(nativeStream);
      const split = bytes.indexOf(Buffer.from("你")) + 1;
      res.write(bytes.subarray(0, split));
      setImmediate(() => res.end(bytes.subarray(split)));
    }
  };
  expect(await (await post("native", { reasoning: { effort: "high" }, metadata: { tag: "retained" } })).json()).toEqual(nativeResult);
  expect(observed[0].path).toBe("/v1/responses");
  expect(observed[0].body).toEqual({ model: "real-native", input: "hello", stream: false, metadata: { tag: "retained" } });
  expect(observed[0].headers.authorization).toBe("Bearer " + upstreamKey);
  expect(observed[0].headers["x-tenant"]).toBe(tenantKey);
  const response = await post("native", { stream: true });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe(nativeStream);
  const rows = context.orm.select().from(usageLogs).all();
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ modelId: "native", providerId: "p-native", inputTokens: 20, outputTokens: 7, costUsd: 0.000075 });
});

test("honors forced Chat mode and accounts CNY prices in their configured currency", async () => {
  addModel("native","responses");
  context.native.prepare("UPDATE providers SET quirks_json=? WHERE id='p-native'").run(JSON.stringify({force_chat:true}));
  context.native.exec("UPDATE models SET pricing_currency='CNY',cost_input_cny_per_million=4,cost_output_cny_per_million=10");
  serve=(_body,res)=>res.end(JSON.stringify({choices:[{message:{content:"hello"},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:7,total_tokens:27}}));
  expect((await (await post("native")).json()).output[0].content[0].text).toBe("hello");
  expect(observed.map(item=>item.path)).toEqual(["/v1/chat/completions"]);
  expect(context.orm.select().from(usageLogs).get()).toMatchObject({costCny:0.00015,costUsd:0});
});

test("bills the active task and distinguishes actual zeroes from missing or partial Chat usage", async()=>{
  addModel("chat","chat");
  context.native.exec(`INSERT INTO workspaces(id,name,path,created_at,updated_at) VALUES('w','w','w','','');
    INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at,active_model_alias) VALUES('t','w','t','running','','','chat');
    INSERT INTO tasks(id,workspace_id,thread_id,prompt,status,created_at,updated_at) VALUES('job','w','t','p','running','','')`);
  const now=Math.floor(Date.now()/1000);
  const claims={aud:"codexdeck-internal",thread_id:"t",task_id:"job",iat:now,exp:now+60,nonce:"fixture"};
  const credential=signPayload(claims,context.masterKey);
  for(const usage of [undefined,{prompt_tokens:0},{prompt_tokens:0,completion_tokens:0}]) {
    serve=(_req,res)=>res.end(JSON.stringify({choices:[{message:{content:"ok"},finish_reason:"stop"}],usage}));
    const result=await post("chat",{},credential);
    expect(result.status).toBe(200); await result.text();
  }
  const rows=context.orm.select().from(usageLogs).all();
  expect(rows.map(row=>row.usageKnown)).toEqual([false,false,true]);
  expect(rows.every(row=>row.taskId==="job" && row.workspaceId==="w" && row.threadId==="t")).toBe(true);
  context.native.exec("UPDATE tasks SET status='cancelled' WHERE id='job'");
  expect((await post("chat",{},credential)).status).toBe(401);
});

test("streams Chat deltas before upstream completion and accounts for a separate final usage chunk", async () => {
  addModel("chat", "chat");
  let finish: () => void = () => {};
  serve = (_body, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chatData({ content: "早" }));
    finish = () => res.end(chatData({ content: "安" }, "stop") +
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":7,"total_tokens":27}}\n\ndata: [DONE]\n\n');
  };
  const response = await post("chat", { stream: true });
  const types: string[] = [];
  const text: string[] = [];
  for await (const frame of readSse(response.body!)) {
    const event = JSON.parse(frame.data);
    types.push(event.type);
    if (event.type === "response.output_text.delta") {
      text.push(event.delta);
      if (text.length === 1) finish();
    }
    if (event.type === "response.completed") {
      expect(event.response.output[0].content[0].text).toBe("早安");
      expect(event.response.usage).toMatchObject(usage);
    }
  }
  expect(text).toEqual(["早", "安"]);
  expect(types).toEqual(["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done",
    "response.output_item.done", "response.completed"]);
  expect(context.orm.select().from(usageLogs).get()).toMatchObject({ inputTokens: 20, outputTokens: 7 });
});

test("translates two interleaved function calls and carries both outputs into the next Chat turn", async () => {
  addModel("chat", "auto");
  const tools = ["left", "right"].map((name) => ({ type: "function", name, parameters: { type: "object" } }));
  serve = (body, res, path) => {
    if (path.endsWith("/responses")) { res.writeHead(404).end(); return; }
    if (!body.stream) {
      res.end(JSON.stringify({ choices: [{ message: { content: "finished" }, finish_reason: "stop" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" }).end(
      chatData({ tool_calls: [
        { index: 0, id: "call-L", function: { name: "left", arguments: '{"x":' } },
        { index: 1, id: "call-R", function: { name: "right", arguments: '{"y":' } },
      ] }) + chatData({ tool_calls: [{ index: 1, function: { arguments: "2}" } }, { index: 0, function: { arguments: "1}" } }] }, "tool_calls")
      + "data: [DONE]\n\n",
    );
  };
  const history = [{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "https://example.invalid/image" }] }];
  const result = await jsonEvents(await post("chat", { instructions: "system", input: history, stream: true, tools, tool_choice: "required" }));
  const calls = result.at(-1).response.output;
  expect(calls).toMatchObject([
    { name: "left", call_id: "call-L", arguments: '{"x":1}' }, { name: "right", call_id: "call-R", arguments: '{"y":2}' },
  ]);
  expect(result.filter((e) => e.type === "response.function_call_arguments.delta").map((e) => [e.output_index, e.delta]))
    .toEqual([[0, '{"x":'], [1, '{"y":'], [1, "2}"], [0, "1}"]]);
  const first = observed.find((r) => r.path.endsWith("/chat/completions"))!.body;
  expect(first.messages).toMatchObject([{ role: "system", content: "system" }, { role: "user", content: [
    { type: "text", text: "look" }, { type: "image_url", image_url: { url: "https://example.invalid/image" } },
  ] }]);
  expect(first.tools[0]).toMatchObject({ type: "function", function: { name: "left" } });
  expect(first.tool_choice).toBe("required");
  const outputs = calls.map((item: { call_id: string }) => ({ type: "function_call_output", call_id: item.call_id, output: "ok" }));
  const next = await (await post("chat", { input: [...history, ...calls, ...outputs] })).json();
  expect(next.output[0].content[0].text).toBe("finished");
  expect(observed.at(-1)!.body.messages.slice(1)).toMatchObject([
    { role: "assistant", tool_calls: [{ id: "call-L" }, { id: "call-R" }] },
    { role: "tool", content: "ok", tool_call_id: "call-L" }, { role: "tool", content: "ok", tool_call_id: "call-R" },
  ]);
});

test("flattens Responses namespace tools and restores namespace in streamed calls",async()=>{
  addModel("namespaced","chat");
  serve=(body,res)=>{
    expect(body.tools).toEqual([{type:"function",function:expect.objectContaining({name:expect.stringMatching(/^ns_[a-f0-9]{20}_port_allocate$/)})}]);
    res.writeHead(200,{"content-type":"text/event-stream"}).end(
      chatData({tool_calls:[{index:0,id:"call-n",function:{name:body.tools[0].function.name,arguments:"{}"}}]}, "tool_calls")+"data: [DONE]\n\n");
  };
  const response=await post("namespaced",{stream:true,tools:[{type:"namespace",name:"codexdeck_ops",tools:[{type:"function",name:"port_allocate",parameters:{type:"object"}}]}]});
  const events=await jsonEvents(response);
  const call=events.find(event=>event.type==="response.output_item.added");
  expect(call.item).toMatchObject({type:"function_call",name:"port_allocate",namespace:"codexdeck_ops"});
});

test("flattens function tools carrying the Codex MCP namespace field",async()=>{
  addModel("mcp","chat");
  serve=(body,res)=>{
    expect(body.tools[0].function.name).toMatch(/^ns_[a-f0-9]{20}_port_allocate$/);
    res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({choices:[{message:{
      tool_calls:[{id:"call-mcp",function:{name:body.tools[0].function.name,arguments:"{}"}}],
    },finish_reason:"tool_calls"}],usage:{prompt_tokens:1,completion_tokens:1}}));
  };
  const result=await (await post("mcp",{tools:[{type:"function",name:"port_allocate",namespace:"mcp__codexdeck_ops",parameters:{type:"object"}}]})).json();
  expect(result.output[0]).toMatchObject({type:"function_call",name:"port_allocate",namespace:"mcp__codexdeck_ops"});
});

test.each([429, 503, "first-event-timeout"] as const)("switches before the first byte after %s and bills the successful channel once", async (status) => {
  addModel("primary", "chat", ["backup"]);
  addModel("backup", "responses");
  if (status === "first-event-timeout") context.gatewayConfig.upstream_timeout_ms = 300;
  serve = (body, res) => {
    if (body.model === "real-primary") {
      if (status === "first-event-timeout") { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); }
      else res.writeHead(status).end();
    } else res.writeHead(200, { "content-type": "text/event-stream" }).end(nativeStream);
  };
  const response = await post("primary", { stream: true });
  expect(await response.text()).toBe(nativeStream);
  expect(response.headers.get("x-codexdeck-failover")).toBe("primary,backup");
  expect(observed.map((r) => r.body.model)).toEqual(["real-primary", "real-backup"]);
  const rows = context.orm.select().from(usageLogs).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ requestedAlias: "primary", modelId: "backup", providerId: "p-backup", failoverFrom: "primary",
    inputTokens: 20, outputTokens: 7, costUsd: 0.000075, statusCode: 200 });
});

test("post-commit stream errors are terminal and never switch upstream", async () => {
  addModel("primary", "chat", ["backup"]);
  addModel("backup", "responses");
  serve = (_body, res) => res.writeHead(200, { "content-type": "text/event-stream" })
    .end(chatData({ content: "partial" }) + "data: " + JSON.stringify({ error: { message: upstreamKey } }) + "\n\n");
  const response = await post("primary", { stream: true });
  const events = await jsonEvents(response);
  expect(events[0].type).toBe("response.created");
  expect(events.at(-1).type).toBe("error");
  expect(JSON.stringify(events)).not.toContain(upstreamKey);
  expect(response.headers.has("x-codexdeck-failover")).toBe(false);
  expect(observed).toHaveLength(1);
  expect(context.orm.select().from(usageLogs).get()).toMatchObject({ statusCode: 502, modelId: "primary" });
});

test("redacts upstream echoes from JSON and SSE while retaining numeric usage", async () => {
  addModel("native", "responses");
  const result = { ...nativeResult, output_text: upstreamKey + " " + tenantKey };
  serve = (body, res) => res.end(body.stream
    ? "data: " + JSON.stringify({ type: "response.completed", response: result }) + "\n\n" : JSON.stringify(result));
  for (const stream of [false, true]) {
    const response = await post("native", { stream });
    const payload = stream ? (await jsonEvents(response)).at(-1).response : await response.json();
    expect(payload.output_text).toBe("[REDACTED] [REDACTED]");
    expect(payload.usage).toEqual(usage);
  }
});

test("redacts a credential split over three Chat deltas before sending fragments", async () => {
  addModel("chat", "chat");
  serve = (_body, res) => res.end(
    chatData({ content: "start:" + upstreamKey.slice(0, 11) })
    + chatData({ content: upstreamKey.slice(11, 21) })
    + chatData({ content: upstreamKey.slice(21) + ":end" }, "stop") + "data: [DONE]\n\n",
  );
  const events = await jsonEvents(await post("chat", { stream: true }));
  expect(events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta).join(""))
    .toBe("start:[REDACTED]:end");
  expect(JSON.stringify(events)).not.toContain(upstreamKey.slice(0, 11));
  expect(events.at(-1).response.output[0].content[0].text).toBe("start:[REDACTED]:end");
});
