import { installationCode } from "../src/routes/auth.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, lstat, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, expect, it } from "vitest";
import Fastify from "fastify";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { gatewayConfigSchema } from "@codexdeck/shared";
import { WorkspaceFiles } from "../src/files/workspace-files.js";
import { registerFileRoutes } from "../src/routes/files.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { signPayload } from "../src/security/crypto.js";
import { schema } from "../src/db/schema.js";
import { runMigrations } from "../src/db/migrations.js";
import { resolveSafeWorkspacePath } from "../src/files/sandbox.js";

const exec = promisify(execFile);
let fixture: string;
let root: string;
let workspace: string;
let pathBase: string;
let key: Buffer;
let native: Database.Database;
let app: ReturnType<typeof Fastify>;
let files: WorkspaceFiles;
let cookie: string;
let events: { thread: string; type: string; payload: unknown }[];

beforeEach(async () => {
  fixture = await mkdtemp(path.join(tmpdir(),"deck-files-"));
  const data = path.join(fixture,"data");
  await mkdir(data);
  native = new Database(":memory:");
  native.pragma("foreign_keys = ON");
  runMigrations(native);
  key = randomBytes(32);
  const ctx = { native, orm: drizzle(native,{ schema }), masterKey: key, masker: new SecretMasker(), gatewayConfig: gatewayConfigSchema.parse({ port: 3210 }) };
  events = [];
  files = new WorkspaceFiles(ctx, data, (thread, type, payload) => events.push({ thread,type,payload }));
  app = Fastify();
  registerAuthRoutes(app,ctx);
  registerFileRoutes(app,ctx,files);
  const admin = await app.inject({ method: "POST", url: "/api/auth/setup", payload: { setup_code: installationCode(ctx.native,ctx.masterKey), password: "test-admin-password" } });
  cookie = String(admin.headers["set-cookie"]).split(";")[0];
  const created = await app.inject({ method: "POST", url: "/api/workspaces", headers: { cookie }, payload: { name: "fixture" } });
  expect(created.statusCode).toBe(201);
  workspace = created.json().id;
  root = await files.getRoot(workspace);
  pathBase = "/api/workspaces/" + workspace;
  native.prepare("INSERT INTO threads(id,workspace_id,title,status,created_at,updated_at) VALUES('thread',?,'file tests','ready','','')").run(workspace);
});
afterEach(async () => {
  await app.close();
  native.close();
  await rm(fixture,{ recursive: true, force: true });
});

it("rejects traversal, links outside, Git metadata and out-of-root writes, including targets which do not exist yet", async () => {
  const outside = path.join(fixture,"outside");
  await mkdir(outside);
  await writeFile(path.join(outside,"private.txt"),"private");
  await symlink(outside,path.join(root,"shortcut"),"junction");
  for (const name of ["../private.txt","sub/../private.txt",".git/config","shortcut/private.txt","shortcut/missing/child"]) {
    const url = pathBase + "/files/content?path=" + encodeURIComponent(name);
    expect((await app.inject({ url,headers: { cookie } })).statusCode,name).toBe(403);
    expect((await app.inject({ method:"PUT",url,headers:{cookie},payload:{content:"overwrite"} })).statusCode,name).toBe(403);
  }
  expect(await readdir(outside)).toEqual(["private.txt"]);
  expect(await readFile(path.join(outside,"private.txt"),"utf8")).toBe("private");
  expect(await resolveSafeWorkspacePath(root,".")).toBe(root);
  const content = pathBase + "/files/content?path=nested%2Fchild.txt";
  expect((await app.inject({ method:"PUT",url:content,headers:{cookie},payload:{content:"Hello ✓"} })).statusCode).toBe(200);
  expect((await app.inject({url:content,headers:{cookie}})).json()).toMatchObject({ content:"Hello ✓",mime_type:"text/plain" });
  await writeFile(path.join(root,"big.txt"),Buffer.alloc(1024*1024+1));
  expect((await app.inject({url:pathBase+"/files/content?path=big.txt",headers:{cookie}})).statusCode).toBe(413);
  expect((await app.inject({url:pathBase+"/files/tree?path=nested",headers:{cookie}})).json()).toEqual([
    {name:"child.txt",path:"nested/child.txt",type:"file"},
  ]);
});

it("keeps global instructions isolated and unregisters without erasing project files", async () => {
  for (const scope of ["project","global"]) {
    const url = pathBase+"/agents-md?scope="+scope;
    expect((await app.inject({method:"PUT",url,headers:{cookie},payload:{content:scope}})).statusCode).toBe(200);
    expect((await app.inject({url,headers:{cookie}})).json()).toMatchObject({content:scope,scope,read_only:false});
  }
  expect(await readFile(path.join(root,"AGENTS.md"),"utf8")).toBe("project");
  expect((await app.inject("/api/workspaces")).statusCode).toBe(401);
  const invalidClone = await app.inject({method:"POST",url:"/api/workspaces/clone",headers:{cookie},payload:{name:"invalid",url:"file:///bad"}});
  expect(invalidClone.statusCode).toBe(400);
  expect((await app.inject({method:"DELETE",url:pathBase,headers:{cookie}})).statusCode).toBe(204);
  expect(await readFile(path.join(root,"AGENTS.md"),"utf8")).toBe("project");
});

it("starts clone asynchronously and exposes a failed Git checkout without serving its partial files", async () => {
  const remote = createTcpServer(socket => socket.destroy());
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  try {
    const address = remote.address() as AddressInfo;
    const response = await app.inject({ method: "POST", url: "/api/workspaces/clone", headers: { cookie },
      payload: { name: "offline remote", url: "https://127.0.0.1:" + address.port + "/fixture.git" } });
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("cloning");
    const id = response.json().id;
    await expect.poll(() => files.list().find(w => w.id === id)?.status, { timeout: 6000 }).toBe("failed");
    expect((await app.inject({ url: "/api/workspaces/" + id + "/files/tree", headers: { cookie } })).statusCode).toBe(409);
  } finally { await new Promise<void>(resolve => remote.close(() => resolve())); }
}, 10000);

it("accepts multipart upload, registers its relative path and enforces signed download identity and expiry", async () => {
  const boundary = "test-file-boundary";
  const raw = "--"+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nfile contents!\r\n--'+boundary+"--\r\n";
  const upload = await app.inject({method:"POST",url:pathBase+"/files/upload",headers:{cookie,"content-type":"multipart/form-data; boundary="+boundary},payload:Buffer.from(raw)});
  expect(upload.statusCode,upload.body).toBe(201);
  expect(upload.json()).toMatchObject({artifact:{change_type:"upload",workspace_id:workspace}});
  const relative = upload.json().path;
  expect(relative).toMatch(/^\.codex-uploads\//);
  expect(await readFile(path.join(root,relative),"utf8")).toBe("file contents!");
  const id = upload.json().artifact.id;
  const signed = await app.inject({method:"POST",url:"/api/artifacts/sign",headers:{cookie},payload:{artifact_id:id}});
  const url = signed.json().download_url as string;
  expect((await app.inject(url)).body).toBe("file contents!");
  await writeFile(path.join(root,relative),"new revision");
  const second = await files.registerArtifact(workspace,null,null,relative,"modified");
  expect((await app.inject(files.signArtifact(second.id))).body).toBe("new revision");
  expect((await app.inject(url)).body).toBe("file contents!");
  const sigStart = url.lastIndexOf(".")+1;
  const tampered = url.slice(0,sigStart)+(url[sigStart] === "A" ? "B" : "A")+url.slice(sigStart+1);
  expect((await app.inject(tampered)).statusCode).toBe(403);
  const expired = signPayload({aud:"artifact-download",kind:"artifact",id,exp:1},key);
  expect((await app.inject("/api/dl/"+expired)).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:"/api/artifacts/sign",headers:{cookie},payload:{path:"../private"}})).statusCode).toBe(400);
  await rm(path.dirname(path.join(root,relative)),{recursive:true});
  await symlink(fixture,path.join(root,".codex-uploads"),"junction");
  expect((await app.inject(url)).body).toBe("file contents!");
});

it("refuses masked or stale whole-file saves, preserving both secrets and newer edits",async()=>{
  const name="settings.txt", file=path.join(root,name), url=pathBase+"/files/content?path="+name;
  const secret="sk-fixture-private-value";
  await writeFile(file,"mode=dev\n"+secret);
  const preview=(await app.inject({url,headers:{cookie}})).json();
  expect(preview.read_only).toBe(true);
  expect(preview.content).not.toContain(secret);
  const save=(revision:string)=>app.inject({method:"PUT",url,headers:{cookie,"if-match":revision},payload:{content:"mine"}});
  expect((await save(preview.revision)).statusCode).toBe(403);
  expect(await readFile(file,"utf8")).toContain(secret);
  await writeFile(file,"before");
  const original=(await app.inject({url,headers:{cookie}})).json();
  await writeFile(file,"newer");
  expect((await save(original.revision)).statusCode).toBe(409);
  expect(await readFile(file,"utf8")).toBe("newer");
  expect((await save((await app.inject({url,headers:{cookie}})).json().revision)).statusCode).toBe(200);
});

// Inspect actual ZIP central directory offsets and inflate the corresponding local records.
function extractZip(bytes: Buffer) {
  let p = bytes.readUInt32LE(bytes.length-6);
  const result: Record<string,string> = {};
  while (bytes.readUInt32LE(p) === 0x02014b50) {
    const size = bytes.readUInt32LE(p+20);
    const nameLength = bytes.readUInt16LE(p+28);
    const name = bytes.subarray(p+46,p+46+nameLength).toString();
    const local = bytes.readUInt32LE(p+42);
    const start = local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    result[name] = inflateRawSync(bytes.subarray(start,start+size)).toString();
    p += 46 + nameLength + bytes.readUInt16LE(p+30) + bytes.readUInt16LE(p+32);
  }
  return result;
}

it("creates an invisible pre-turn checkpoint, tracks changed files, streams a ZIP and restores the worktree without staging", async () => {
  const git = async (...args: string[]) => (await exec("git",["-c","core.autocrlf=false","-c","user.name=Test","-c","user.email=test@localhost",...args],{cwd:root,windowsHide:true})).stdout;
  await git("init");
  await writeFile(path.join(root,".gitignore"),"build.out\n");
  await writeFile(path.join(root,"tracked.txt"),"base");
  await git("add","tracked.txt");
  await git("commit","-m","original");
  await writeFile(path.join(root,"tracked.txt"),"staged");
  await git("add","tracked.txt");
  await writeFile(path.join(root,"tracked.txt"),"unstaged");
  await writeFile(path.join(root,"untracked.txt"),"keep");
  const head = await git("rev-parse","HEAD");
  const index = await readFile(path.join(root,".git","index"));
  const before = await files.beforeTurn(workspace,"thread","turn-1");
  expect(await git("log","--oneline")).toMatch(/^[^\n]+original\r?\n$/);
  expect(await readFile(path.join(root,".git","index"))).toEqual(index);
  await writeFile(path.join(root,"tracked.txt"),"changed");
  await writeFile(path.join(root,"new.txt"),"new");
  await writeFile(path.join(root,"build.out"),"ignored");
  await rm(path.join(root,"untracked.txt"));
  const artifacts = await files.afterTurn(workspace,"thread","turn-1",before);
  expect(artifacts.map(a=>[a.path,a.change_type]).sort()).toEqual([["new.txt","added"],["tracked.txt","modified"]]);
  expect(events.at(-1)?.type).toBe("artifacts_updated");
  const signed = await app.inject({method:"POST",url:"/api/artifacts/sign",headers:{cookie},payload:{turn_id:"turn-1"}});
  const zip = await app.inject(signed.json().download_url);
  expect(zip.headers["content-type"]).toContain("application/zip");
  expect(extractZip(zip.rawPayload)).toEqual({"new.txt":"new","tracked.txt":"changed"});
  expect((await app.inject({url:pathBase+"/git/diff?format=patch",headers:{cookie}})).body).toContain("diff --git");
  const restored = await app.inject({method:"POST",url:pathBase+"/checkpoints/turn-1/restore",headers:{cookie}});
  expect(restored.statusCode,restored.body).toBe(200);
  expect(events.at(-1)?.type).toBe("checkpoint_restored");
  expect(await git("rev-parse","HEAD")).toEqual(head);
  expect(await readFile(path.join(root,".git","index"))).toEqual(index);
  expect(await readFile(path.join(root,"tracked.txt"),"utf8")).toBe("unstaged");
  expect(await readFile(path.join(root,"untracked.txt"),"utf8")).toBe("keep");
  await expect(lstat(path.join(root,"new.txt"))).rejects.toMatchObject({code:"ENOENT"});
},15000);
