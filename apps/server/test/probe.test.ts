import { installationCode } from "../src/routes/auth.js";
import { randomBytes } from "node:crypto";
import {listenHttpFixture} from "./fixtures/http-port.js";
import { createServer as mockServer, type IncomingMessage, type ServerResponse } from "node:http";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { targetPolicy, upstreamFetch } from "../src/gateway/transport.js";

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
  url = "http://127.0.0.1:" + await listenHttpFixture(upstream);
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

test("imports the same upstream model from two channels and keeps repeated imports idempotent", async () => {
  const first = await createProvider(url);
  const second = await createProvider(url);
  const load = async (provider_id: string) => (await app.inject({
    method: "POST", url: "/api/models/batch", headers: { cookie },
    payload: { provider_id, models: [{ model_id: "shared-model" }] },
  })).json();
  expect((await load(first)).imported[0].alias).toBe("shared-model");
  const other = await load(second);
  expect(other.imported).toHaveLength(1);
  expect(other.imported[0]).toMatchObject({ provider_id: second, model_id: "shared-model" });
  expect(other.imported[0].alias).not.toBe("shared-model");
  expect(await load(second)).toEqual({ imported: [], skipped: ["shared-model"] });
});

test("separates balance credentials, discovers and batch imports deduplicated models and benchmarks actual streams",async()=>{
  const management="test-control-management-only",inference="test-inference-only";
  const headers={cookie};
  const p=await app.inject({method:"POST",url:"/api/providers",headers,payload:{name:"relay",preset:"openrouter",base_url:url+"/v1",api_keys:[inference],balance_token:management}});
  expect(p.statusCode).toBe(201);
  expect(p.json().keys).toHaveLength(1);
  const providerId=p.json().id;
  const path="/api/providers/"+providerId;
  const seen:{path:string;authorization?:string}[]=[];
  const limits:unknown[]=[];
  let denyBalance=false;
  handle=(req,res,body)=>{
    seen.push({path:req.url!,authorization:req.headers.authorization});
    if(req.url==="/api/v1/credits") {
      if(denyBalance) res.writeHead(403).end();else res.end(JSON.stringify({data:{total_credits:100,total_usage:12}}));
    } else if(req.url==="/v1/models") res.end(JSON.stringify({data:[{id:"model-a",context_length:200000,supported_parameters:["tools"],supports_reasoning_summaries:true},{id:"model-a"},{id:"tiny-32k"}]}));
    else {
      limits.push(body.max_output_tokens);
      const delta='data: {"type":"response.output_text.delta","delta":"a"}\n\n';
      res.writeHead(200,{"content-type":"text/event-stream"});
      res.write(delta);
      setTimeout(()=>{
        if(body.max_output_tokens===32) res.write(delta);
        res.end(`data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":${body.max_output_tokens===32?3:1}}}}\n\n`);
      },20);
    }
  };
  const post=(url:string,payload?:Record<string,unknown>)=>app.inject({method:"POST",url,headers,payload});
  const balance=(await post(path+"/balance")).json();
  expect(balance).toMatchObject({status:"ok",amount:88,unit:"USD"});
  denyBalance=true;
  expect((await post(path+"/balance")).json()).toMatchObject({status:"unauthorized",amount:88,balance_at:balance.balance_at});
  const list=(await post(path+"/fetch-models")).json();
  expect(list.models).toEqual([{model_id:"model-a",context_window:200000,context_source:"upstream",capabilities:["tools","reasoning_summary"]},{model_id:"tiny-32k",context_window:32000,context_source:"inferred",capabilities:[]}]);
  const selection={provider_id:providerId,models:list.models};
  const created=(await post("/api/models/batch",selection)).json();
  expect(created.imported).toHaveLength(2);
  expect((await post("/api/models/batch",selection)).json()).toMatchObject({imported:[],skipped:["model-a","tiny-32k"]});
  const id=created.imported[0].id;
  const fast=(await post("/api/models/benchmark",{model_ids:[id]})).json().results[0];
  expect(fast).toMatchObject({model_id:id,status:"ok",tokens_per_sec:null,ttft_ms:expect.any(Number)});
  const detailed=(await post("/api/models/benchmark",{model_ids:[id],sample_tokens:32})).json().results[0];
  expect(detailed.tokens_per_sec).toBeGreaterThan(0);
  expect(limits).toEqual([1,32]);
  expect((await app.inject({url:"/api/models/"+id,headers})).json().last_benchmark).toEqual(detailed);
  for(const entry of seen) expect(entry.authorization).toBe("Bearer "+(entry.path==="/api/v1/credits"?management:inference));
  expect((await app.inject({method:"PATCH",url:path,headers,payload:{balance_endpoint:"https://example.com/credits"}})).statusCode).toBe(400);
  const changed=await app.inject({method:"PATCH",url:path,headers,payload:{api_keys:["relay-key-3333"],retain_key_ids:[p.json().keys[0].id]}});
  expect(changed.json().keys.map((entry:{masked:string})=>entry.masked)).toEqual(["...only","...3333"]);
  expect(changed.body+p.body).not.toContain(management);
  expect(changed.body+p.body).not.toContain(inference);
});

test("keeps quota in upstream units and never forwards an inference key or private headers to the balance endpoint",async()=>{
  let auth:string|undefined,userId:string|undefined,tenant:string|undefined;
  handle=(req,res)=>{
    auth=req.headers.authorization;userId=String(req.headers["new-api-user"]);tenant=req.headers["x-tenant"] as string|undefined;
    res.end(JSON.stringify({success:true,data:{quota:500000}}));
  };
  const provider=(await app.inject({method:"POST",url:"/api/providers",headers:{cookie},payload:{
    name:"relay",preset:"oneapi_newapi",base_url:url,api_key:"fixture-inference",headers:{"x-tenant":"private-tenant"},
    balance_token:"fixture-management",balance_user_id:"7",
  }})).json();
  const endpoint="/api/providers/"+provider.id+"/balance";
  expect((await app.inject({method:"POST",url:endpoint})).statusCode).toBe(401);
  expect((await app.inject({method:"POST",url:endpoint,headers:{cookie}})).json()).toMatchObject({status:"ok",amount:500000,unit:"quota"});
  expect({auth,userId,tenant}).toEqual({auth:"Bearer fixture-management",userId:"7",tenant:undefined});
  const local=await createProvider(url);
  expect((await app.inject({method:"POST",url:`/api/providers/${local}/balance`,headers:{cookie}})).json()).toMatchObject({status:"unsupported",amount:null});
  expect(paths).toEqual(["/api/user/self"]);
});

test("requires fresh credentials when a provider moves to a different origin",async()=>{
  const headers={cookie};
  const prior=(await app.inject({method:"POST",url:"/api/providers",headers,payload:{name:"old",preset:"custom",base_url:"https://old.example.org/v1",
    api_keys:["old-origin-token"],headers:{"x-private":"old-origin-header"},balance_token:"old-management"}})).json();
  const endpoint="/api/providers/"+prior.id;
  const refused=await app.inject({method:"PATCH",url:endpoint,headers,payload:{base_url:url,retain_key_ids:[prior.keys[0].id]}});
  expect(refused.statusCode).toBe(409);
  const newUrl=await app.inject({method:"PATCH",url:endpoint,headers,payload:{base_url:url}});
  expect(newUrl.json()).toMatchObject({base_url:url,keys:[],headers:{},has_balance_token:false,api_key_masked:null});
  let observed:IncomingMessage["headers"]={};
  handle=(req,res)=>{observed=req.headers;res.end('{"data":[]}');};
  expect((await app.inject({method:"POST",url:endpoint+"/fetch-models",headers})).statusCode).toBe(200);
  expect(observed.authorization).toBeUndefined();
  expect(observed["x-private"]).toBeUndefined();
  const fresh=await app.inject({method:"PATCH",url:endpoint,headers,payload:{base_url:"https://new.example.org",api_keys:["fresh-origin-key"]}});
  expect(fresh.json().keys[0].masked).toBe("...-key");
});

test("benchmarks the real Chat contract and accepts measured token-limit responses with no text",async()=>{
  const provider_id=await createProvider(url);
  const headers={cookie};
  const createModel=async(protocol:string)=>(await app.inject({method:"POST",url:"/api/models",headers,payload:{alias:protocol,model_id:protocol,provider_id,protocol}})).json().id;
  const chat=await createModel("chat"),responses=await createModel("responses");
  const check=async(id:string)=>(await app.inject({method:"POST",url:"/api/models/benchmark",headers,payload:{model_ids:[id]}})).json().results[0];
  let caseName="capped";
  handle=(req,res,body)=>{
    if(req.url==="/v1/chat/completions" && (body.max_completion_tokens!==1 || "max_tokens" in body)) {res.writeHead(400).end();return;}
    res.writeHead(200,{"content-type":"text/event-stream"});
    if(req.url==="/v1/chat/completions") {
      if(caseName==="truncated") res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      if(caseName==="capped") res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}],"usage":{"prompt_tokens":8,"completion_tokens":1}}\n\n');
      res.end('data: [DONE]\n\n');return;
    }
    const reason=caseName==="capped"?"max_output_tokens":"content_filter";
    res.end(`data: ${JSON.stringify({type:"response.incomplete",response:{status:"incomplete",incomplete_details:{reason},usage:{input_tokens:8,output_tokens:1}}})}\n\n`);
  };
  for(const id of [chat,responses]) expect(await check(id)).toMatchObject({status:"ok",ttft_ms:null,tokens_per_sec:null,output_tokens:1});
  caseName="truncated";
  expect(await check(chat)).toMatchObject({status:"failed"});
  expect(await check(responses)).toMatchObject({status:"failed"});
});

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

test("blocks untrusted private upstreams and preserves loopback and trusted HTTP origins",async()=>{
  const publicPolicy=targetPolicy(new URL("https://api.openai.com"),true,[3210]);
  expect(publicPolicy).toBeTruthy();
  expect(targetPolicy(new URL("http://api.openai.com:12345"),false,[3210])).toBe(publicPolicy);
  expect(()=>targetPolicy(new URL("http://10.20.30.40:12345"),false,[3210])).toThrow(/network policy/);
  const loopbackPolicy=targetPolicy(new URL("http://127.0.0.1:11434"),false,[3210]);
  expect(loopbackPolicy).not.toBe(publicPolicy);

  const domainTarget=new URL("http://localhost.:12345");
  expect(targetPolicy(domainTarget,false,[3210])).toBe(publicPolicy);
  await expect(upstreamFetch(domainTarget,{method:"GET",headers:new Headers(),signal:AbortSignal.timeout(3000)},false,[3210]))
    .rejects.toMatchObject({cause:expect.objectContaining({message:"Provider address blocked by network policy."})});

  const previous=process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS;
  const trusted="http://10.20.30.40:12345";
  try {
    process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS=trusted;
    const trustedPolicy=targetPolicy(new URL(trusted),true,[3210]);
    expect(trustedPolicy).not.toBe(publicPolicy);
    expect(trustedPolicy).not.toBe(loopbackPolicy);
  } finally {
    if(previous===undefined) delete process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS;
    else process.env.CODEXDECK_TRUSTED_HTTP_ORIGINS=previous;
  }

  for(const host of ["localhost","127.0.0.1","[::1]","[::ffff:7f00:0001]"])
    expect(()=>targetPolicy(new URL("https://"+host),true,[3210])).toThrow(/protected/);
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
