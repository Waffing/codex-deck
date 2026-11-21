import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Run against an ephemeral Compose installation, using only a new fixture
// database and its own deployment IDs. The fixture uses the shipped packages.
async function exercise() {
  const { default: assert } = await import("node:assert/strict");
  const { randomBytes, randomUUID } = await import("node:crypto");
  const { mkdir, mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { setTimeout: delay } = await import("node:timers/promises");
  const { default: Fastify } = await import("fastify");
  const { default: websocket } = await import("@fastify/websocket");
  const { stagingInput, verificationInput } = await import("@codexdeck/shared");
  const { openDatabase } = await import("./dist/db/index.js");
  const { WorkspaceFiles } = await import("./dist/files/workspace-files.js");
  const { SecretMasker } = await import("./dist/security/secret-masker.js");
  const { command } = await import("./dist/server-ops/probe.js");
  const { registerOps } = await import("./dist/server-ops/routes.js");
  const fixture = await mkdtemp("/data/deploy-smoke-");
  const db = await openDatabase(fixture);
  const ctx = { ...db, masker: new SecretMasker(), masterKey: randomBytes(32), gatewayConfig:{port:3000} };
  const files = new WorkspaceFiles(ctx, fixture, () => {});
  const workspace = (await files.create("Release smoke", "semi")).id;
  const root = await files.getRoot(workspace);
  const page = marker => `<!doctype html><html><head><link rel="icon" href="data:,"></head><body>${marker}</body></html>`;
  await mkdir(root+"/public");
  let app, service, origin;
  async function start() {
    app = Fastify();
    await app.register(websocket);
    service = registerOps(app, ctx, files, {append(){}}, {async requestOpsApproval(){return true;}},
      {dataDirectory:fixture, portPool:[27100,27300]});
    origin = await app.listen({host:"127.0.0.1",port:0});
  }
  const criteria = (id, opts) => verificationInput.parse({deployment_id:id,...opts});
  const live = async () => {
    const res = await fetch(origin+"/live/"+workspace+"/");
    assert.equal(res.status,200);
    return res.text();
  };
  const stage = opts => service.deployer.stage(workspace,null,stagingInput.parse(opts),service.getProfile());
  try {
    await start();
    assert.equal(service.getProfile().docker_available,true,"Control process cannot reach Docker proxy");
    const tracking = await files.create("Isolated Git tracking", "unrestricted");
    const checkout = await files.getRoot(tracking.id);
    const git = args => command("git", args, {cwd:checkout});
    await git(["init"]);
    await git(["config","user.name","Smoke Author"]);
    await writeFile(checkout+"/.gitattributes","*.txt text eol=lf\n");
    await writeFile(checkout+"/note.txt","before\n");
    await git(["add",".gitattributes","note.txt"]);
    await git(["-c","user.email=fixture@localhost","commit","-m","fixture"]);
    const index = await readFile(checkout+"/.git/index");
    const head = await git(["rev-parse","HEAD"]);
    await files.markIsolatedHistory(tracking.id);
    const checkpoint = await files.track(tracking.id,"before","smoke-checkpoint");
    assert.equal(checkpoint.ref,"refs/codexdeck/checkpoints/smoke-checkpoint");
    await writeFile(checkout+"/note.txt","after\n");
    assert.match((await files.track(tracking.id,"status")).porcelain,/note\.txt/);
    assert.match(await files.track(tracking.id,"diff"),/\+after/);
    const captured = await files.track(tracking.id,"after","smoke-checkpoint");
    assert.deepEqual(captured.changes.files,[{path:"note.txt",added:1,removed:1}]);
    await files.track(tracking.id,"restore","smoke-checkpoint");
    assert.equal(await readFile(checkout+"/note.txt","utf8"),"before\n");
    assert.deepEqual(await readFile(checkout+"/.git/index"),index);
    assert.equal(await git(["rev-parse","HEAD"]),head);
    const proxy=process.env.DOCKER_HOST.replace(/^tcp:/,"http:");
    const inventory=new URL("/volumes",proxy);
    inventory.searchParams.set("filters",JSON.stringify({label:{["com.docker.compose.project=codexdeck-"+randomUUID()]:true}}));
    assert.equal((await fetch(inventory)).status,200);
    assert.equal((await fetch(new URL("/volumes",proxy))).status,403);
    inventory.searchParams.set("extra","1");
    assert.equal((await fetch(inventory)).status,403);
    assert.equal((await fetch(new URL("/volumes/create",proxy),{method:"OPTIONS"})).status,403);
    const marker = randomUUID();
    await writeFile(root+"/public/index.html",page("live-A-"+marker));
    const a = await stage({mode:"docker"});
    const check = criteria(a.id,{expected_content:"live-A-"+marker,check_browser:process.env.CODEXDECK_REQUIRE_BROWSER==="1"});
    const first = await service.deployer.promote(check);
    assert.equal(first.verification.ok,true,JSON.stringify(first.verification));
    if(check.check_browser) {
      assert.equal(first.verification.browser.status,"completed");
      assert.equal(first.verification.browser.artifacts.length,2);
      for(const id of first.verification.browser.artifacts) {
        const relative=db.native.prepare("SELECT path FROM artifacts WHERE id=?").pluck().get(id);
        assert.equal((await readFile(root+"/"+relative)).subarray(0,8).toString("hex"),"89504e470d0a1a0a");
      }
    }
    assert.match(await live(),/live-A-/);
    await writeFile(root+"/public/index.html",page("live-B-"+marker));
    const b = await stage({mode:"compose"});
    let verifying=true;
    const observed=(async()=>{const seen=[];do {seen.push(await live());await delay(10);} while(verifying);return seen;})();
    let rejected;
    try { rejected=await service.deployer.promote(criteria(b.id,{expected_content:"absent"})); }
    finally {verifying=false;}
    for(const body of await observed) assert.ok(body.includes("live-A-"+marker));
    assert.equal(rejected.verification.ok,false);
    assert.equal((await service.deployer.promote(criteria(b.id,{expected_content:"live-B-"+marker}))).verification.ok,true);
    assert.ok((await live()).includes("live-B-"+marker));
    await app.close();
    await start();
    assert.ok((await live()).includes("live-B-"+marker));
    await service.deployer.rollback(b.id,workspace);
    assert.ok((await live()).includes("live-A-"+marker));

    await writeFile(root+"/public/main.mjs",[
      'import http from "node:http"; import { lookup } from "node:dns/promises";',
      'const management=await lookup("docker-socket-proxy").then(()=>"visible",()=>"isolated");',
      'console.log("fixture started"); console.error("UncaughtException fixture");',
      'http.createServer((req,res)=>res.end(management)).listen(Number(process.env.PORT),process.env.HOST);',
    ].join("\n"));
    const entry=await stage({mode:"auto",entry:"main.mjs",public_dir:"public"});
    const report=await service.deployer.promote(criteria(entry.id,{expected_content:"isolated"}));
    assert.equal(report.verification.http.status,200);
    assert.equal(report.verification.http.content_match,true);
    assert.equal(report.verification.ok,false);
    assert.ok(report.verification.logs.issues.some(line=>line.includes("[stderr] UncaughtException")));
    const spec=JSON.parse(await command("docker",["inspect","codexdeck-"+entry.id]))[0];
    assert.deepEqual(Object.keys(spec.NetworkSettings.Networks),[process.env.CODEXDECK_DEPLOYMENT_NETWORK]);
    assert.equal(spec.Config.User,process.getuid()+":"+process.getgid());
    assert.equal(spec.HostConfig.PidsLimit,128);
    assert.equal(spec.HostConfig.Memory,512*1024*1024);
    assert.equal(spec.HostConfig.NanoCpus,1e9);
    await assert.rejects(stage({mode:"local",entry:"main.mjs",public_dir:"public"}),{statusCode:403});
    assert.ok((await live()).includes("live-A-"+marker));
  } catch(error) {
    if(service) for(const row of service.deployer.rows().filter(row=>row.status==="failed")) {
      console.error("Failed deployment",row.id,(await service.deployer.logs(row.id).catch(()=>"Log unavailable.")).slice(-2048));
    }
    throw error;
  } finally {
    try {
      if(service) for(const row of service.deployer.rows()) await service.deployer.stop(row.id);
    } finally {
      await app?.close();
      db.native.close();
      await rm(fixture,{recursive:true});
    }
  }
}

const container = process.env.CODEXDECK_SMOKE_CONTAINER;
assert.ok(container && /^[a-z0-9][\w.-]*$/i.test(container),"Set CODEXDECK_SMOKE_CONTAINER to a test control container");
const result = spawnSync("docker", ["exec","-i","--workdir","/app/apps/server","--env",
  "CODEXDECK_REQUIRE_BROWSER="+(process.env.CODEXDECK_REQUIRE_BROWSER==="1"?"1":"0"),"--env","DEBUG=pw:browser",container,
  "sh","-ec",'exec gosu "$PUID:$PGID" node --input-type=module'],
  {input:`await (${exercise.toString()})();`,stdio:["pipe","inherit","inherit"]});
if(result.error) throw result.error;
process.exitCode=result.status ?? 1;
