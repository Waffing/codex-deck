import {randomUUID} from "node:crypto";
import {chmod, realpath} from "node:fs/promises";
import {createServer, request} from "node:http";
import {hostname} from "node:os";
import path from "node:path";
import {once} from "node:events";
import {command} from "../server-ops/probe.js";
import {workspaceDirectory} from "../security/paths.js";

type Mount = {Type:string; Source:string; Destination:string};

export async function executorRuntime() {
  if (process.platform !== "linux" || !process.getuid?.()) {
    throw new Error("完全访问需要以普通用户运行的 Linux 控制面与 Docker 执行镜像。");
  }
  let image = process.env.CODEXDECK_EXECUTOR_IMAGE;
  let mounts:Mount[] | undefined;
  if (process.env.CODEXDECK_DEPLOYMENT_NETWORK) {
    const fields = await command("docker",["inspect","--format","{{.Image}} {{json .Mounts}}",hostname()]);
    image ??= fields.slice(0,fields.indexOf(" "));
    mounts = JSON.parse(fields.slice(fields.indexOf(" ") + 1));
  }
  if (!image || image.startsWith("-")) throw new Error("请配置已安装的 CodexDeck 执行镜像。");
  const result = await command("docker",["image","inspect","--format",'{{.Id}} {{index .Config.Labels "io.codexdeck.executor"}}',image]);
  const [id,protocol]=result.split(" ");
  if (!/^sha256:[a-f0-9]{64}$/.test(id) || protocol!=="1") throw new Error("执行镜像需要支持 CodexDeck V1.3。");
  return {id,mounts};
}

export async function hasIsolatedRunner() {
  try { await executorRuntime(); return true; } catch { return false; }
}

export function mountSource(file:string,mounts?:Mount[]) {
  if (!mounts) return file;
  const mount=mounts.filter(m=>m.Type==="bind" && (file===m.Destination || file.startsWith(m.Destination+"/")))
    .sort((a,b)=>b.Destination.length-a.Destination.length)[0];
  if (!mount || !path.isAbsolute(mount.Source)) throw new Error("执行目录需要独立的 Docker bind mount。");
  return path.join(mount.Source,path.relative(mount.Destination,file));
}

export function projectMountSource(project:string,data:string,mounts?:Mount[]) {
  const source=mountSource(project,mounts);
  const relative=path.relative(source,mountSource(data,mounts));
  if (!relative || (relative!==".." && !relative.startsWith(".."+path.sep) && !path.isAbsolute(relative))) {
    throw new Error("执行工作区与控制面数据目录必须分开。");
  }
  return source;
}

export async function isolatedRunner(options:{
  workspace:string; data:string; config:string; threadId:string; workspaceId:string;
  leases:Record<"model"|"ops",string>; port:number; reviewed:boolean; readOnly?:boolean;
}) {
  const {id,mounts}=await executorRuntime();
  const uid=process.getuid!(),gid=process.getgid!();
  const data=await realpath(options.data), project=await realpath(options.workspace);
  const sourceProject=projectMountSource(project,data,mounts);
  const state=await workspaceDirectory(data,path.join(options.readOnly?"plan-sessions":options.reviewed?"reviewed-sessions":"executor-sessions",options.threadId),true);
  const cache=options.readOnly ? undefined : await workspaceDirectory(data,path.join(options.reviewed?"reviewed-caches":"executor-caches",options.workspaceId),true);
  const relayDir=await workspaceDirectory(data,"executor-relays",true);
  const name="codexdeck-turn-"+randomUUID();
  const socket=path.join(relayDir,name.slice(-12)+".sock");
  if(Buffer.byteLength(socket)>=104) throw new Error("数据目录过长，无法创建本地执行通道。");
  // The runner can reach only the model and ops routes with its current leases.
  const relay=createServer((req,res)=>{
    const route=req.url??"";
    const lease=route==="/internal/v1/responses" ? options.leases.model
      : !options.readOnly && /^\/internal\/ops\/[a-z_]+$/.test(route) ? options.leases.ops : undefined;
    if(req.method!=="POST" || !lease || req.headers.authorization!=="Bearer "+lease) {
      res.writeHead(403).end();return;
    }
    const upstream=request({host:"127.0.0.1",port:options.port,method:"POST",path:route,
      headers:{authorization:"Bearer "+lease,"content-type":"application/json"}},response=>{
      res.writeHead(response.statusCode??502,{"content-type":response.headers["content-type"]??"application/json"});
      response.once("error",()=>res.destroy());
      response.pipe(res);
    });
    upstream.once("error",()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    res.once("close",()=>upstream.destroy());
    req.pipe(upstream);
  });
  const args=["run","--rm","-i","--init","--pull","never","--name",name,"--network",options.readOnly?"none":"bridge",
    "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--user",uid+":"+gid,
    "--pids-limit","128","--memory","512m","--memory-swap","512m","--cpus","1","--no-healthcheck",
    "--tmpfs","/tmp:size=64m,mode=1777","--tmpfs","/home/runner:size=32m,uid="+uid+",gid="+gid,
    "--tmpfs","/codex:size=32m,uid="+uid+",gid="+gid,
    "--workdir","/workspace","--env","HOME=/home/runner","--env","CODEX_HOME=/codex",
    "--env","NPM_CONFIG_CACHE=/cache/npm","--env","PIP_CACHE_DIR=/cache/pip","--env","UV_CACHE_DIR=/cache/uv",
    "--env","CODEXDECK_INTERNAL_TOKEN",...(options.readOnly?[]:["--env","CODEXDECK_OPS_TOKEN","--env","CODEXDECK_OPS_URL=http://127.0.0.1:3141/internal/ops"])];
  for(const [local,target,ro] of [[project,"/workspace",options.readOnly],[state,"/codex/sessions",false],
    [cache,"/cache",false],[await realpath(options.config),"/run/deck-config",true],[socket,"/run/deck.sock",true]] as const) {
    if(!local) continue;
    const source=target==="/workspace" ? sourceProject : mountSource(local,mounts);
    if (/[,"\r\n]/.test(source)) throw new Error("执行目录名称包含 Docker 不支持的字符。");
    args.push("--mount","type=bind,src="+source+",dst="+target+(ro?",readonly":""));
  }
  args.push("--entrypoint","node",id,"/app/apps/server/dist/codex/runner-entry.js");
  relay.listen(socket);
  await once(relay,"listening");
  try {await chmod(socket,0o600);} catch(e){relay.close();throw e;}
  let closing:Promise<void>|undefined;
  return {args,env:{PATH:process.env.PATH,DOCKER_HOST:process.env.DOCKER_HOST,
    CODEXDECK_INTERNAL_TOKEN:options.leases.model,CODEXDECK_OPS_TOKEN:options.leases.ops},
    dispose:()=>closing??=(async()=>{
      relay.close();relay.closeAllConnections();
      await command("docker",["rm","-f",name],{timeout:10000}).catch(()=>{}); // --rm also removes normally exited runners.
    })()};
}
