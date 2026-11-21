import { installationCode } from "../src/routes/auth.js";
import { createHmac, randomBytes } from "node:crypto";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { createServer, parseGatewayConfig } from "../src/app.js";
import { openDatabase } from "../src/db/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { readSse } from "../src/gateway/sse.js";

test("public tasks enforce scope and workspace, resume SSE, sign retried callbacks and download actual turn artifacts",async () => {
  const root = await mkdtemp(path.join(tmpdir(),"deck-public-"));
  const data = path.join(root,"data");
  await mkdir(data);
  const db = await openDatabase(data,root);
  const ctx = {...db,masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const fake = fileURLToPath(new URL("../tests/fixtures/fake-app-server.mjs",import.meta.url));
  const app = createServer(ctx,{dataDirectory:data,workspaceRoot:root,codexBin:fake});
  const callbacks:{raw:string;signature:string}[] = [];
  const webhook = httpServer(async (req,res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    callbacks.push({raw,signature:String(req.headers["x-codexdeck-signature"])});
    res.writeHead(callbacks.length === 1 ? 503 : 204).end();
  });
  try {
    webhook.listen(0,"127.0.0.1");
    await once(webhook,"listening");
    const destination = "http://127.0.0.1:"+(webhook.address() as AddressInfo).port;
    const url = await app.listen({host:"127.0.0.1",port:0});
    const setup = await app.inject({method:"POST",url:"/api/auth/setup",payload:{ setup_code: installationCode(ctx.native,ctx.masterKey),password:"testing-public-api-pass"}});
    const cookie = String(setup.headers["set-cookie"]).split(";")[0];
    const admin = (route:string,payload:object) => app.inject({method:"POST",url:route,payload,headers:{cookie}});
    const project = (await admin("/api/workspaces",{name:"target"})).json().id;
    const other = (await admin("/api/workspaces",{name:"other"})).json().id;
    const provider = await admin("/api/providers",{name:"mock",preset:"custom",base_url:destination});
    await admin("/api/models",{provider_id:provider.json().id,model_id:"fixture",alias:"test"});
    async function issue(scopes:string[],rate_limit_rpm=100) {
      const r=await admin("/api/api-keys",{name:"test",scopes,workspace_ids:[project],webhook_origins:[destination],rate_limit_rpm});
      expect(r.statusCode).toBe(201);
      return r.json() as {id:string;api_key:string;webhook_signing_secret:string};
    }
    const key = await issue(["tasks:read","tasks:write","files:download"]);
    const bearer = {authorization:"Bearer "+key.api_key};
    const post = (workspace_id:string,prompt="create the test file") => fetch(url+"/api/v1/tasks",{method:"POST",headers:{...bearer,"content-type":"application/json","Idempotency-Key":"delivery-1"},
      body:JSON.stringify({workspace_id,prompt,model_alias:"test",webhook_url:destination+"/callback"})});
    expect((await post(other)).status).toBe(403);
    const [created,retry] = await Promise.all([post(project),post(project)]);
    expect(created.status).toBe(202);
    const {task_id} = await created.json();
    expect(retry.status).toBe(202);
    expect((await retry.json()).task_id).toBe(task_id);
    expect((await post(project,"different")).status).toBe(409);
    expect(db.native.prepare("SELECT count(*) FROM tasks").pluck().get()).toBe(1);
    const resource = url+"/api/v1/tasks/"+task_id;
    const stream = await fetch(resource+"/stream",{headers:{...bearer,"accept-encoding":"br, gzip"}});
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(stream.headers.get("content-encoding")).toBeNull();
    let received = 0;
    for await (const frame of readSse(stream.body!)) {
      if (!frame.data) continue;
      received=JSON.parse(frame.data).seq_id;
      break;
    }
    expect(received).toBeGreaterThan(0);
    const resumed = await fetch(resource+"/stream",{headers:{...bearer,"Last-Event-ID":String(received)}});
    const events = [];
    for await (const frame of readSse(resumed.body!)) if (frame.data) events.push(JSON.parse(frame.data));
    expect(events[0].seq_id).toBe(received+1);
    expect(events.at(-1).type).toBe("task_completed");
    expect(new Set(events.map(e=>e.seq_id)).size).toBe(events.length);
    const task = await (await fetch(resource,{headers:bearer})).json();
    expect(task.status).toBe("completed");
    expect(task.summary).toContain("complete");
    const artifact = task.artifacts.find((a:{path:string})=>a.path==="result.txt");
    const download = await fetch(new URL(artifact.download_url,url));
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("CodexDeck test artifact\n");
    await expect.poll(()=>callbacks.length,{timeout:6500}).toBe(2);
    for (const callback of callbacks) {
      expect(callback.signature).toBe("sha256="+createHmac("sha256",key.webhook_signing_secret).update(callback.raw).digest("hex"));
      expect(JSON.parse(callback.raw)).toMatchObject({task_id,status:"completed"});
    }
    const limited = await issue(["tasks:read"],2);
    const headers = {authorization:"Bearer "+limited.api_key};
    expect((await (await fetch(resource,{headers})).json()).artifacts[0]).not.toHaveProperty("download_url");
    expect((await fetch(resource+"/cancel",{method:"POST",headers})).status).toBe(403);
    expect((await fetch(resource,{headers})).status).toBe(429);
    const listed=await app.inject({url:"/api/api-keys",headers:{cookie}});
    expect(listed.body).not.toContain(key.api_key);
    expect(listed.body).not.toContain(key.webhook_signing_secret);
    expect(JSON.stringify(db.native.prepare("SELECT * FROM api_keys").all())).not.toContain(key.api_key);
    await app.inject({url:"/api/api-keys/"+key.id,method:"DELETE",headers:{cookie}});
    expect((await fetch(resource,{headers:bearer})).status).toBe(401);
  } finally {
    await app.close();
    webhook.closeAllConnections();
    if (webhook.listening) await new Promise<void>(resolve=>webhook.close(()=>resolve()));
    db.native.close();
    await rm(root,{recursive:true,force:true});
  }
},30000);
