import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import {createRequire} from "node:module";
import { hostname } from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { command } from "../server-ops/probe.js";
import { repositoryRoot } from "../security/paths.js";

export type Mount = { Type: string; Source: string; Destination: string };
type Runtime = { strategy:"docker"; id:string; image:string; mounts?:Mount[] } |
  { strategy:"native"|"container_sandbox"; id:null; image:null; mounts?:undefined };
const imageReference = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

export function savedExecutorImage(db?:Database.Database) {
  return db?.prepare("SELECT value FROM settings WHERE key='executor.image'").pluck().get() as string|undefined;
}

export function saveExecutorImage(db:Database.Database, image:unknown) {
  if(typeof image!=="string" || (image!=="" && !imageReference.test(image))) {
    throw Object.assign(new Error("请输入有效的本地镜像名称或留空以自动探测。"),{statusCode:400});
  }
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES('executor.image',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(image,new Date().toISOString());
}

export async function resolveExecutor(options:{
  linux:boolean; nonRoot:boolean; inContainer:boolean; native:boolean;
  configured?:string; controlImage?:string; dockerHost?:string;
}, run=command):Promise<Runtime> {
  if(!options.linux || !options.nonRoot) throw new Error("完全访问需要非 root Linux 服务及可用的隔离执行环境。");
  if(!options.native && (options.inContainer || options.configured || options.dockerHost)) {
    let mounts:Mount[]|undefined, current:string|undefined;
    if(options.inContainer) {
      try {
        const raw=await run("docker",["inspect","--format","{{.Image}} {{json .Mounts}}",hostname()]);
        const at=raw.indexOf(" ");
        const result:unknown=JSON.parse(raw.slice(at+1));
        if(at>0 && Array.isArray(result)) {current=raw.slice(0,at);mounts=result;}
      } catch { /* The socket proxy can forbid introspection. Use namespace isolation below. */ }
    }
    if(!options.inContainer || mounts) {
      const candidates=new Set([options.configured, current, options.controlImage].filter((v):v is string=>!!v));
      if(!options.configured) {
        try {
          const installed=await run("docker",["image","ls","--filter","label=io.codexdeck.executor=1","--no-trunc","--format","{{.Repository}} {{.ID}}"]);
          for(const line of installed.split("\n")) {
            const [repo,id]=line.split(" ");
            if(/(?:^|\/)(?:codex-deck|codexdeck)$/.test(repo)) candidates.add(id);
          }
        } catch { /* Named candidates can still work if inventory access is limited. */ }
      }
      for(const image of candidates) {
        if(!imageReference.test(image)) throw new Error("执行镜像引用无效。");
        const result=await run("docker",["image","inspect","--format",'{{.Id}} {{index .Config.Labels "io.codexdeck.executor"}}',image]).catch(()=>"");
        const [id,protocol]=result.split(" ");
        if(/^sha256:[a-f0-9]{64}$/.test(id) && protocol==="1") {
          // Image inspection can succeed on a read-only proxy that denies container creation.
          try {
            await run("docker",["run","--rm","--pull","never","--network","none","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
              "--pids-limit","8","--memory","32m","--user","65534:65534","--entrypoint","/bin/true",id],{timeout:10000});
            return {strategy:"docker",id,image,mounts};
          } catch { break; }
        }
        if(options.configured) throw new Error("指定的执行镜像不可用，请安装带 CodexDeck 执行器标签的镜像或清除覆盖设置。");
      }
    }
  }
  try {
    await run("/usr/bin/bwrap",[...namespaceBase(),"--","/bin/true"]);
  } catch {
    throw new Error("隔离执行环境不可用。请启用非 root bubblewrap 用户命名空间，或恢复专用 Docker 执行器。");
  }
  return {strategy:options.inContainer?"container_sandbox":"native",image:null,id:null};
}

let lastProbe:{key:string;expires:number;runtime:Promise<Runtime>}|undefined;
export function executorRuntime(db?:Database.Database, refresh=false) {
  const native=process.env.CODEXDECK_INSTALL_MODE==="native";
  const options={linux:process.platform==="linux",nonRoot:!!process.getuid?.(),native,
    inContainer:!native && (process.env.CODEXDECK_INSTALL_MODE==="docker" || !!process.env.CODEXDECK_DEPLOYMENT_NETWORK || existsSync("/.dockerenv") || existsSync("/run/.containerenv")),
    configured:savedExecutorImage(db) || process.env.CODEXDECK_EXEC_IMAGE || process.env.CODEXDECK_EXECUTOR_IMAGE,
    controlImage:process.env.CODEXDECK_IMAGE,dockerHost:process.env.DOCKER_HOST};
  const key=JSON.stringify(options);
  if(!refresh && lastProbe?.key===key && lastProbe.expires>Date.now()) return lastProbe.runtime;
  const runtime=resolveExecutor(options);
  lastProbe={key,expires:Date.now()+30_000,runtime};
  return runtime;
}

export async function executionStatus(db:Database.Database,refresh=false) {
  const configured_image=savedExecutorImage(db) ?? "";
  try {
    const r=await executorRuntime(db,refresh);
    return {configured_image,available:true,strategy:r.strategy,image:r.image,image_id:r.id,
      detail:r.strategy==="docker"?"独立项目容器，工作区与外部网络可用。":"独立文件与进程命名空间。完全访问允许通过 HTTPS 代理连接公网 443，模型与运维请求使用会话专用通道。"};
  } catch(e) {
    return {configured_image,available:false,strategy:"unavailable",image:null,image_id:null,detail:(e as Error).message};
  }
}

// Start with an empty root. In particular the control database, host homes, proc
// and Docker socket must never become visible to processes from the workspace.
function namespaceBase() {
  return ["--unshare-all","--die-with-parent","--new-session","--cap-drop","ALL",
    "--setenv","PATH","/usr/local/bin:/usr/bin:/bin","--ro-bind","/usr/bin","/usr/bin","--ro-bind","/usr/lib","/usr/lib","--ro-bind-try","/usr/lib64","/usr/lib64",
    "--ro-bind-try","/usr/libexec","/usr/libexec","--ro-bind","/usr/share","/usr/share",
    "--ro-bind-try","/usr/local/bin","/usr/local/bin","--ro-bind-try","/usr/local/lib","/usr/local/lib",
    "--ro-bind","/bin","/bin",
    "--ro-bind","/lib","/lib","--ro-bind-try","/lib64","/lib64","--dev","/dev","--proc","/proc","--tmpfs","/tmp"];
}

export async function namespaceArgs() {
  const root=await realpath(repositoryRoot);
  const args=[...namespaceBase(),"--setenv","HOME","/tmp","--setenv","PATH","/run/deck-bin:/usr/local/bin:/usr/bin:/bin","--ro-bind-try","/etc/ssl/certs","/etc/ssl/certs","--ro-bind",await realpath(process.execPath),"/run/deck-bin/node"];
  if(process.env.CODEX_BIN && path.isAbsolute(process.env.CODEX_BIN)) {
    const binary=await realpath(process.env.CODEX_BIN);
    if(binary.endsWith("/@openai/codex/bin/codex.js")) {
      const triple=(process.arch==="arm64"?"aarch64":"x86_64")+"-unknown-linux-musl";
      let pkg=path.resolve(path.dirname(binary),"..");
      try {pkg=path.dirname(createRequire(binary).resolve("@openai/codex-linux-"+process.arch+"/package.json"));} catch { /* bundled vendor layout */ }
      const vendor=await realpath(path.join(pkg,"vendor",triple));
      args.push("--ro-bind",vendor,"/run/deck-codex","--symlink","/run/deck-codex/bin/codex","/run/deck-bin/codex");
    } else {
      args.push("--ro-bind",binary,"/run/deck-bin/codex");
    }
  }
  // Only shipped program files and dependencies; a source checkout may also
  // contain .env, a database, and unrelated workspaces alongside these paths.
  for(const sub of ["apps/server/dist","packages/ops-mcp/dist","packages/ops-mcp/node_modules","packages/ops-mcp/package.json",
    "packages/shared/dist","packages/shared/package.json","packages/shared/node_modules","node_modules"]) {
    const local=path.join(root,sub);
    if(existsSync(local)) args.push("--ro-bind",await realpath(local),"/app/"+sub);
  }
  return args;
}
