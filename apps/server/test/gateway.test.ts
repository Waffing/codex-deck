import {turnMetrics} from "../src/codex/timeline.js";
import {listenHttpFixture,withTestHttpPort} from "./fixtures/http-port.js";
import { createHash, randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, test } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createServer, parseGatewayConfig, type ServerContext } from "../src/app.js";
import { models, providers, schema, usageLogs } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";
import { createInternalToken, encryptSecret, signPayload } from "../src/security/crypto.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { registerWorkspaceSecret } from "../src/security/workspace-secrets.js";
import { keyFields,sealHeaders } from "../src/gateway/credentials.js";
import { readSse } from "../src/gateway/sse.js";

const upstreamKey = "fixture.opaque-provider-passphrase";
const tenantKey = "fixture-private-tenant";
const usage = { input_tokens: 20, output_tokens: 7, total_tokens: 27 };
const nativeResult = { id: "resp_fixed", object: "response", status: "completed", model: "real-native", output: [], usage };
const nativeStream = ": service heartbeat\r\n\r\n"
  + "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"你好\"}\r\n\r\n"
  + "event: response.completed\r\ndata: " + JSON.stringify({ type: "response.completed", response: nativeResult }) + "\r\n\r\n";

type Upstream = (body: Record<string, any>, response: ServerResponse, path: string) => void;
let observed: { headers: IncomingHttpHeaders; path: string; body: Record<string, any>;raw:string }[];
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
    observed.push({ headers: req.headers, path: req.url!, body,raw:text });
    serve(body, res, req.url!);
  });
  mockUrl = "http://127.0.0.1:" + await listenHttpFixture(mock) + "/v1";
  app = createServer(context);
  url = await withTestHttpPort(port=>app.listen({host:"127.0.0.1",port}));
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

function proxyKey(scopes=["responses","messages","chat","models"]) {
  const key="cdk_live_"+randomBytes(16).toString("hex");
  context.native.prepare("INSERT INTO api_keys(id,name,key_hash,scopes_json,created_at,allowed_models_json) VALUES(?,?,?,?,?,?)")
    .run(key.slice(-10),"test",createHash("sha256").update(key).digest("hex"),JSON.stringify(scopes.map(s=>"proxy:"+s)),new Date().toISOString(),'["alpha"]');
  return key;
}
function external(path:string,body:Record<string,unknown>,key:string){
  return fetch(url+"/v1/"+path,{method:"POST",headers:{authorization:"Bearer "+key,"content-type":"application/json"},body:JSON.stringify(body)});
}
test.each([false,true])("charges the reserved hard budget when a delivered upstream result omits usage (stream=%s)",async(stream)=>{
  addModel("alpha","responses");
  context.native.exec("UPDATE providers SET daily_budget=1,budget_action='block'; UPDATE models SET cost_input_usd_per_million=0,cost_output_usd_per_million=1000000");
  serve=(_body,res)=> {
    if(stream) res.writeHead(200,{"content-type":"text/event-stream"}).end('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n');
    else res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({...nativeResult,usage:null}));
  };
  const key=proxyKey(),body={model:"alpha",input:"go",stream,max_output_tokens:1};
  const first=await external("responses",body,key);expect(first.status).toBe(200);
  await first.text();
  const second=await external("responses",body,key);expect(second.status).toBe(429);
  expect(observed).toHaveLength(1);
  expect(context.native.prepare("SELECT usage_known FROM usage_logs WHERE model_id='alpha'").pluck().get()).toBe(0);
  expect(context.native.prepare("SELECT amount FROM gateway_budget_usage WHERE owner_type='provider'").pluck().get()).toBe(1);
});
test("Messages upstream processes signed thinking and tool history, and accounts cache reads",async()=>{
  addModel("alpha","auto");
  context.native.prepare("UPDATE providers SET protocol_type='anthropic_messages'").run();
  serve=(_body,res)=>res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({id:"msg_a",type:"message",role:"assistant",
    content:[{type:"thinking",thinking:"plan",signature:"signed"},{type:"tool_use",id:"call",name:"probe",input:{x:1}}],
    usage:{input_tokens:3,cache_read_input_tokens:4,output_tokens:8},stop_reason:"tool_use"}));
  const response=await external("responses",{model:"alpha",instructions:"Be precise",input:[
    {role:"user",content:"first"},{type:"reasoning",summary:[{type:"summary_text",text:"choose"}],encrypted_content:"original_signature"},
    {type:"function_call",call_id:"previous",name:"probe",arguments:'{"x":0}'},{type:"function_call_output",call_id:"previous",output:"ok"}
  ],tools:[{type:"function",name:"probe",parameters:{type:"object"}}],tool_choice:"required"},proxyKey());
  expect(response.status).toBe(200);
  expect(observed[0]).toMatchObject({path:"/v1/messages",headers:{"x-api-key":upstreamKey,"anthropic-version":"2023-06-01"},
    body:{model:"real-alpha",system:"Be precise",messages:[{role:"user"},{role:"assistant",content:[
      {type:"thinking",thinking:"choose",signature:"original_signature"},{type:"tool_use",id:"previous",input:{x:0}}]},
      {role:"user",content:[{type:"tool_result",tool_use_id:"previous",content:[{text:"ok"}]}]}],tool_choice:{type:"any"}}});
  expect(observed[0]!.headers.authorization).toBeUndefined();
  expect(await response.json()).toMatchObject({output:[{type:"reasoning",encrypted_content:"signed"},{type:"function_call",arguments:'{"x":1}'}],
    usage:{input_tokens:7,output_tokens:8,input_tokens_details:{cached_tokens:4}}});
  expect(context.native.prepare("SELECT * FROM gateway_request_logs").get()).toMatchObject({source_type:"external",inbound_protocol:"responses",outbound_protocol:"anthropic_messages",input_tokens:7,cached_tokens:4});
});

test("translates Messages stream block boundaries, signed thinking and split tool JSON to Chat and Responses",async()=>{
  addModel("alpha","auto");context.native.prepare("UPDATE providers SET protocol_type='anthropic_messages'").run();
  const events=[
    {type:"message_start",message:{type:"message",id:"msg_a",content:[],usage:{input_tokens:5,output_tokens:1}}},
    {type:"content_block_start",index:0,content_block:{type:"thinking",thinking:"",signature:""}},
    {type:"content_block_delta",index:0,delta:{type:"thinking_delta",thinking:"reason"}},
    {type:"content_block_delta",index:0,delta:{type:"signature_delta",signature:"signed"}},{type:"content_block_stop",index:0},
    {type:"content_block_start",index:1,content_block:{type:"tool_use",id:"c1",name:"read",input:{}}},
    {type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:'{"x":'}},
    {type:"content_block_delta",index:1,delta:{type:"input_json_delta",partial_json:"4}"}},{type:"content_block_stop",index:1},
    {type:"message_delta",delta:{stop_reason:"tool_use"},usage:{output_tokens:8}},{type:"message_stop"}];
  serve=(_body,res)=>res.writeHead(200,{"content-type":"text/event-stream"}).end(events.map(e=>"event: "+e.type+"\ndata: "+JSON.stringify(e)+"\n\n").join(""));
  const key=proxyKey();
  const result=await jsonEvents(await external("responses",{model:"alpha",input:"go",stream:true},key));
  expect(result.at(-1)).toMatchObject({type:"response.completed",response:{usage:{input_tokens:5,output_tokens:8},
    output:[{type:"reasoning",encrypted_content:"signed"},{call_id:"c1",arguments:'{"x":4}'}]}});
  const response=await external("chat/completions",{model:"alpha",messages:[{role:"user",content:"go"}],stream:true,stream_options:{include_usage:true}},key);
  const frames=[];
  for await(const f of readSse(response.body!))if(f.data && f.data!=="[DONE]")frames.push(JSON.parse(f.data));
  expect(frames.at(-1)).toMatchObject({choices:[],usage:{prompt_tokens:5,completion_tokens:8}});
  expect(frames.flatMap(c=>c.choices).some(c=>c.delta.reasoning_content==="reason")).toBe(true);
  expect(frames.flatMap(c=>c.choices).map(c=>c.delta.tool_calls?.[0]?.function.arguments??"").join("")).toBe('{"x":4}');
});

test("Claude Messages clients consume Responses upstream tool calls and return tool_result in the next request",async()=>{
  addModel("alpha","responses");const key=proxyKey();
  const item={type:"function_call",id:"fc_1",call_id:"c1",name:"check",arguments:""};
  const events=[{type:"response.created",response:{...nativeResult,usage:null}},
    {type:"response.output_item.added",output_index:0,item},
    {type:"response.function_call_arguments.delta",output_index:0,item_id:item.id,delta:'{"a":2}'},
    {type:"response.output_item.done",output_index:0,item:{...item,arguments:'{"a":2}'}},
    {type:"response.completed",response:{...nativeResult,output:[{...item,arguments:'{"a":2}'}]}}];
  serve=(body,res)=>body.stream?res.writeHead(200,{"content-type":"text/event-stream"}).end(events.map(e=>"data: "+JSON.stringify(e)+"\n\n").join(""))
    :res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({...nativeResult,output:[{type:"message",content:[{type:"output_text",text:"done"}]}]}));
  const result=await jsonEvents(await external("messages",{model:"alpha",max_tokens:12,messages:[{role:"user",content:"go"}],stream:true},key));
  expect(result.map(e=>e.type)).toEqual(["message_start","content_block_start","content_block_delta","content_block_stop","message_delta","message_stop"]);
  expect(result[2]).toMatchObject({delta:{type:"input_json_delta",partial_json:'{"a":2}'}});
  expect(result[4]).toMatchObject({delta:{stop_reason:"tool_use"}});
  const response=await external("messages",{model:"alpha",max_tokens:12,messages:[{role:"assistant",content:[{type:"tool_use",id:"c1",name:"check",input:{a:2}}]},
    {role:"user",content:[{type:"tool_result",tool_use_id:"c1",content:"success"}]}]},key);
  expect(await response.json()).toMatchObject({type:"message",content:[{type:"text",text:"done"}]});
  expect(observed[1]!.body.input).toEqual([{type:"function_call",call_id:"c1",name:"check",arguments:'{"a":2}'},{type:"function_call_output",call_id:"c1",output:"success"}]);
});
test("all public proxy endpoints require independent scopes and filter model access",async()=>{
  addModel("alpha","responses");addModel("hidden","responses");
  const key=proxyKey(["models","responses"]);
  for(const path of ["responses","chat/completions","messages"])expect((await external(path,{},"invalid")).status).toBe(401);
  expect((await fetch(url+"/v1/models")).status).toBe(401);
  const res=await fetch(url+"/v1/models",{headers:{authorization:"Bearer "+key}});
  expect((await res.json()).data.map((m:{id:string})=>m.id)).toEqual(["alpha"]);
  expect((await external("messages",{},key)).status).toBe(403);
  expect((await external("responses",{model:"hidden",input:"go"},key)).status).toBe(403);
  expect(observed).toHaveLength(0);
});

test("external quota rejects requests with Retry-After before contacting the upstream and filters Gemini Chat patches",async()=>{
  addModel("alpha","auto");
  context.native.prepare("UPDATE providers SET protocol_type='gemini_openai', patch_rules_json=?")
    .run(JSON.stringify({developer_to_system:true,map_max_tokens:true,strip_fields:["reasoning_effort"],extra_body:{custom_hint:true}}));
  const key=proxyKey();
  context.native.prepare("UPDATE api_keys SET rate_limit_rpm=1").run();
  serve=(_body,res)=>res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:2,completion_tokens:1}}));
  const body={model:"alpha",messages:[{role:"developer",content:"do"},{role:"user",content:"go"}],max_tokens:7,reasoning_effort:"low"};
  const first=await external("chat/completions",body,key);
  expect(first.status).toBe(200);
  expect(observed[0]).toMatchObject({path:"/v1/chat/completions",body:{messages:[{role:"system"},{role:"user"}],max_tokens:7,custom_hint:true}});
  expect(observed[0]!.body).not.toHaveProperty("reasoning_effort");
  expect(observed[0]!.body).not.toHaveProperty("max_completion_tokens");
  expect(await first.json()).toMatchObject({choices:[{message:{content:"ok"}}],usage:{total_tokens:3}});
  const limit=await external("chat/completions",body,key);
  expect(limit.status).toBe(429);
  expect(Number(limit.headers.get("retry-after"))).toBeGreaterThan(0);
  expect(observed).toHaveLength(1);
});

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

test("remembers pricing at request time, including confirmed free and unknown rates",async()=>{
  addModel("price-history","responses");
  serve=(_body,r)=>r.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify(nativeResult));
  const db=context.native;
  db.prepare("UPDATE models SET cost_input_usd_per_million=0,cost_output_usd_per_million=0 WHERE id=?").run("price-history");
  const capture=async(task:string)=>{
    expect((await post("price-history")).status).toBe(200);
    db.prepare("UPDATE usage_logs SET turn_id=? WHERE turn_id IS NULL").run(task);
  };
  await capture("unknown");
  db.prepare("UPDATE models SET pricing_currency='CNY',confirmed_free=1 WHERE id=?").run("price-history");
  await capture("free");
  db.prepare("UPDATE models SET pricing_currency='USD',confirmed_free=0,cost_input_usd_per_million=1 WHERE id=?").run("price-history");
  await capture("paid");
  db.prepare("UPDATE models SET cost_input_usd_per_million=0 WHERE id=?").run("price-history");
  const metrics=(task:string)=>turnMetrics(db,"unused",task,Date.now(),[],"");
  expect(metrics("unknown")).toMatchObject({cost_usd:null,cost_cny:null,price_recorded:true});
  expect(metrics("free")).toMatchObject({cost_usd:null,cost_cny:0,price_recorded:true});
  expect(metrics("paid")).toMatchObject({cost_usd:0.00002,cost_cny:null,price_recorded:true});
});

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
  expect(observed[0].body).toEqual({ model: "real-native", input: "hello", stream: false, max_output_tokens:16384,metadata: { tag: "retained" } });
  expect(observed[0].headers.authorization).toBe("Bearer " + upstreamKey);
  expect(observed[0].headers["x-tenant"]).toBe(tenantKey);
  const response = await post("native", { stream: true });
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await response.text()).toBe(nativeStream);
  const rows = context.orm.select().from(usageLogs).all();
  expect(rows).toHaveLength(2);
  for (const row of rows) expect(row).toMatchObject({ modelId: "native", providerId: "p-native", inputTokens: 20, outputTokens: 7, costUsd: 0.000075 });
});

test.each(["responses","chat"])("redacts only registered vault literals in outbound %s conversation and tool text",async protocol=>{
  addModel("safe",protocol);
  const value='canary-"'+randomBytes(15).toString("hex")+'\\vault', old=randomBytes(23).toString("hex");
  registerWorkspaceSecret(context,old);
  registerWorkspaceSecret(context,value);
  const preserved="Bearer example_documentation";
  const name="inspect",call="call_123";
  const definition={type:"function",name,description:"Read output",parameters:{type:"object",properties:{password:{type:"string"}}}};
  serve=(_b,res)=>res.end(protocol==="chat"?JSON.stringify({choices:[{message:{content:"ok"}}]}):JSON.stringify(nativeResult));
  const result=await post("safe",{instructions:"key "+old,input:[
    {role:"user",content:[{type:"input_text",text:preserved+" "+value}]},
    {type:"function_call",name,call_id:call,arguments:JSON.stringify({password:value})},
    {type:"function_call_output",call_id:call,output:JSON.stringify({stdout:value,previous:old})},
  ],tools:[definition]});
  expect(result.status).toBe(200);
  const {headers,body,raw}=observed[0];
  expect(raw).not.toContain(old);
  expect(raw).not.toContain(value.match(/[a-f0-9]{30}/)![0]);
  expect(raw).toContain(preserved);
  expect(headers.authorization).toBe("Bearer "+upstreamKey);
  expect(headers["x-tenant"]).toBe(tenantKey);
  if(protocol==="responses") {
    expect(body.instructions).toBe("key [REDACTED]");
    expect(body.input[1]).toEqual({type:"function_call",name,call_id:call,arguments:'{"password":"[REDACTED]"}'});
    expect(JSON.parse(body.input[2].output)).toEqual({stdout:"[REDACTED]",previous:"[REDACTED]"});
    expect(body.tools).toEqual([definition]);
  } else {
    expect(body.messages[0].content).toBe("key [REDACTED]");
    expect(body.messages[2].tool_calls[0]).toEqual({id:call,type:"function",function:{name,arguments:'{"password":"[REDACTED]"}'}});
    expect(JSON.parse(body.messages[3].content)).toEqual({stdout:"[REDACTED]",previous:"[REDACTED]"});
    expect(body.messages[3].tool_call_id).toBe(call);
  }
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

test("rotates healthy keys, cools rejected keys, masks echoes and bills cached input only once",async()=>{
  addModel("pool","responses");
  const secrets=["tenant-secret-A1123","tenant-secret-B2345","tenant-secret-C9876"];
  const sealed=keyFields({api_keys:secrets},context);
  context.native.prepare("UPDATE providers SET api_keys_enc=?,api_key_ciphertext=?,api_key_masked=?").run(sealed.apiKeysEnc,sealed.apiKeyCiphertext,sealed.apiKeyMasked);
  context.native.exec("UPDATE models SET cache_read_price_per_1m=0.5");
  let fail=false;
  serve=(_body,res)=>{
    const auth=observed.at(-1)!.headers.authorization;
    if(fail && auth!==`Bearer ${secrets[2]}`) {
      res.writeHead(auth===`Bearer ${secrets[0]}`?429:401,{"retry-after":"60"}).end(secrets[0]);return;
    }
    res.end(JSON.stringify({...nativeResult,output:[{text:secrets.join("/")}],usage:{input_tokens:20,output_tokens:7,input_tokens_details:{cached_tokens:8}}}));
  };
  for(let i=0;i<3;i++) {
    const body=await (await post("pool")).text();
    for(const key of secrets) expect(body).not.toContain(key);
  }
  expect(observed.map(r=>r.headers.authorization)).toEqual(secrets.map(key=>"Bearer "+key));
  fail=true;
  for(let i=0;i<2;i++) expect((await post("pool")).status).toBe(200);
  expect(observed.slice(3).map(r=>r.headers.authorization)).toEqual([0,1,2,2].map(i=>"Bearer "+secrets[i]));
  const entries=context.orm.select().from(usageLogs).all();
  expect(entries).toHaveLength(5);
  for(const row of entries) expect(row).toMatchObject({cachedInputTokens:8,costUsd:0.000063,failoverFrom:null});
  for(const key of secrets) expect(JSON.stringify(entries)+JSON.stringify(context.orm.select().from(providers).all())).not.toContain(key);
});

test("tries each key before switching models on a pool of unauthorized keys",async()=>{
  addModel("backup","responses");addModel("primary","responses",["backup"]);
  const sealed=keyFields({api_keys:["primary-test-first","primary-test-second"]},context);
  context.native.prepare("UPDATE providers SET rotation_strategy='failover',api_keys_enc=? WHERE id='p-primary'").run(sealed.apiKeysEnc);
  serve=(body,res)=>body.model==="real-primary"?res.writeHead(401).end():res.end(JSON.stringify(nativeResult));
  const response=await post("primary");
  expect(response.status).toBe(200);
  expect(response.headers.get("x-codexdeck-failover")).toBe("primary,backup");
  expect(observed.map(r=>r.headers.authorization)).toEqual(["Bearer primary-test-first","Bearer primary-test-second","Bearer "+upstreamKey]);
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
