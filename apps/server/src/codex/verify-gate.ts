import {spawn,execFile} from "node:child_process";
import {randomUUID} from "node:crypto";
import {realpath} from "node:fs/promises";
import {createInterface} from "node:readline";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";
import {verifyGateConfigSchema,type VerifyGateConfig,type VerifyGateResult} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {fileError,openWorkspaceFile} from "../files/sandbox.js";
import type {SecretMasker} from "../security/secret-masker.js";
import {executorRuntime,projectMountSource} from "./isolated-runner.js";
import {OutputMasker} from "./output-masker.js";

export function readVerifyConfig(ctx:Pick<ServerContext,"native">,id:string):VerifyGateConfig {
  const row=ctx.native.prepare("SELECT auto_verify_enabled,verify_network_enabled,verify_commands_json,max_self_heal_retries,review_model_alias FROM workspaces WHERE id=?").get(id) as
    {auto_verify_enabled:number;verify_network_enabled:number;verify_commands_json:string;max_self_heal_retries:number;review_model_alias:string|null}|undefined;
  if(!row) throw fileError(404,"Workspace not found.");
  const {verify_commands_json,...rest}=row;
  return verifyGateConfigSchema.parse({...rest,auto_verify_enabled:!!row.auto_verify_enabled,verify_network_enabled:!!row.verify_network_enabled,verify_commands:JSON.parse(verify_commands_json)});
}

export async function detectVerifyCommands(root:string) {
  const manifest=async(path:string)=>{
    try {
      const handle=await openWorkspaceFile(root,path);
      try {
        const contents=Buffer.alloc(256*1024+1);
        const {bytesRead}=await handle.read(contents);
        if(bytesRead===contents.length) throw fileError(413,"Manifest is too large.");
        return contents.toString("utf8",0,bytesRead);
      } finally {await handle.close();}
    } catch(e) {if((e as {statusCode:number}).statusCode===404)return null;throw e;}
  };
  const [node,python,go,rust]=await Promise.all(["package.json","pyproject.toml","go.mod","Cargo.toml"].map(manifest));
  const commands:string[]=[];
  if(node!==null) {
    let pkg;try {pkg=JSON.parse(node);} catch {throw fileError(422,"Invalid package.json.");}
    const pinned=typeof pkg?.packageManager==="string"?pkg.packageManager.split("@")[0]:null;
    const pm=pinned && ["npm","pnpm","yarn","bun"].includes(pinned)?pinned:await manifest("pnpm-workspace.yaml")!==null?"pnpm":"npm";
    for(const key of ["lint","typecheck","test","build"]) if(typeof pkg?.scripts?.[key]==="string") commands.push(pm+" run "+key);
  }
  if(python!==null) commands.push(/\bpytest\b/.test(python)?"python3 -m pytest":"python3 -m unittest discover");
  if(go!==null) commands.push("go test ./...");
  if(rust!==null) commands.push("cargo test");
  return commands;
}

type GateOptions={root:string;data:string;config:VerifyGateConfig;env:Record<string,string>;masker:SecretMasker;
  signal:AbortSignal;attempt:number;progress:(state:VerifyGateResult & {current_command:string})=>void};
const exec=promisify(execFile);
const commandMs=120_000;
async function sandbox(opts:GateOptions) {
  if(process.platform!=="linux" || !process.getuid?.()) throw new Error("质检需要非 root Linux Docker 执行器或可用的 systemd 用户沙箱。");
  const root=await realpath(opts.root),data=await realpath(opts.data),name="codexdeck-verify-"+randomUUID();
  const unit=name+".service",uid=process.getuid!(),gid=process.getgid!();
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH};
  if(process.env.CODEXDECK_DEPLOYMENT_NETWORK || process.env.CODEXDECK_EXECUTOR_IMAGE) {
    const {id,mounts}=await executorRuntime();
    const source=projectMountSource(root,data,mounts);
    if(/[,"\r\n]/.test(source)) throw new Error("Unsupported workspace mount path.");
    env.DOCKER_HOST=process.env.DOCKER_HOST;
    return {file:"docker",args:["run","--rm","-i","--init","--log-driver","none","--pull","never","--name",name,"--network",opts.config.verify_network_enabled?"bridge":"none",
      "--read-only","--user",uid+":"+gid,"--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","128","--memory","768m","--memory-swap","768m","--cpus","1",
      "--no-healthcheck","--tmpfs","/tmp:size=512m,mode=1777,exec","--mount","type=bind,src="+source+",dst=/source,readonly","--entrypoint","node",id,
      "/app/apps/server/dist/codex/verify-entry.js"],env,stop:()=>exec("docker",["rm","-f",name],{env,timeout:10_000})};
  }
  projectMountSource(root,data);
  env.XDG_RUNTIME_DIR="/run/user/"+uid;
  const worker=await realpath(fileURLToPath(new URL("./verify-entry.js",import.meta.url)));
  const node=await realpath(process.execPath);
  const args=["--user","--wait","--pipe","--quiet","--collect","--unit="+unit,
    "-p","NoNewPrivileges=yes","-p","MemoryMax=768M","-p","MemorySwapMax=0","-p","TasksMax=128","-p","CPUQuota=100%",
    "-p","RuntimeMaxSec="+(30+commandMs/1000*(opts.config.verify_commands.length+1)),"--","/usr/bin/bwrap","--unshare-all","--die-with-parent","--new-session",
    ...(opts.config.verify_network_enabled?["--share-net","--ro-bind-try","/etc/resolv.conf","/etc/resolv.conf","--ro-bind-try","/etc/ssl/certs","/etc/ssl/certs"]:[]),
    "--clearenv","--setenv","PATH","/usr/local/bin:/usr/bin:/bin","--ro-bind","/usr","/usr","--ro-bind","/bin","/bin",
    "--ro-bind","/lib","/lib","--ro-bind-try","/lib64","/lib64","--proc","/proc","--dev","/dev","--tmpfs","/tmp","--ro-bind",worker,"/verify.mjs",
    "--ro-bind",node,"/verify-node","--ro-bind",root,"/source","--","/verify-node","/verify.mjs"];
  return {file:"systemd-run",args,env,stop:()=>exec("systemctl",["--user","stop",unit],{env,timeout:10_000})};
}

export async function runVerifyGate(opts:GateOptions):Promise<VerifyGateResult> {
  const result:VerifyGateResult={status:"running",attempt:opts.attempt,max_retries:opts.config.max_self_heal_retries,commands:[]};
  if(opts.signal.aborted) return {...result,status:"cancelled"};
  if(!opts.config.verify_commands.length) throw new Error("请先配置质检命令。");
  const runner=await sandbox(opts);
  return collectVerification(opts,runner);
}

export async function collectVerification(opts:GateOptions,runner:{file:string;args:string[];env:NodeJS.ProcessEnv;stop:()=>Promise<unknown>}):Promise<VerifyGateResult> {
  const result:VerifyGateResult={status:"running",attempt:opts.attempt,max_retries:opts.config.max_self_heal_retries,commands:[]};
  if(opts.signal.aborted) return {...result,status:"cancelled"};
  const child=spawn(runner.file,runner.args,{env:runner.env,stdio:"pipe"});
  let stopping:Promise<unknown>|undefined,timeout=false;
  const stop=()=>{stopping??=runner.stop().catch(()=>{});child.kill("SIGKILL");};
  const timer=setTimeout(()=>{timeout=true;stop();},commandMs);
  opts.signal.addEventListener("abort",stop,{once:true});
  child.stdin.on("error",()=>{});
  child.stdin.end(JSON.stringify({commands:opts.config.verify_commands,env:opts.env}));
  // Keep head and tail after masking, so chunk boundaries and truncation cannot expose a secret.
  let output="",active=-1,finished=0;
  let flushTimer:NodeJS.Timeout|undefined;
  const report=()=>opts.progress({...result,current_command:result.commands.at(-1)?.command??""});
  const masker=new OutputMasker(opts.masker,(_method,p)=>{
    output+=p.delta;
    if(output.length>12_288) output=output.slice(0,4096)+"\n…\n"+output.slice(-4096);
    if(!flushTimer && active>=0) flushTimer=setTimeout(()=>{
      flushTimer=undefined;
      if(active>=0 && result.commands[active].output!==output) {
        result.commands[active].output=output;report();
      }
    },750);
  });
  const lines=createInterface({input:child.stdout});
  child.stderr.resume();
  lines.on("line",line=>{
    let frame;try {frame=JSON.parse(line);} catch {return;}
    if(frame?.kind==="start" && frame.index===finished && active===-1 && finished<opts.config.verify_commands.length) {
      active=finished;output="";timer.refresh();
      result.commands.push({command:opts.masker.maskString(opts.config.verify_commands[active]),output:"",exit_code:null});report();
    } else if(frame?.index===active && active>=0) {
      if(frame.kind==="output" && typeof frame.text==="string") masker.push("verify-output",{delta:frame.text,stream:frame.stream});
      if(frame.kind==="end") {
        masker.flush();result.commands[active].output=output;result.commands[active].exit_code=Number.isSafeInteger(frame.code)?frame.code:null;
        clearTimeout(flushTimer);flushTimer=undefined;
        finished++;active=-1;report();
      }
    }
  });
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);});
    masker.flush();
    if(active>=0) result.commands[active].output=output+(timeout?"\n命令执行超时。":"");
    if(opts.signal.aborted) return {...result,status:"cancelled"};
    if(!result.commands.length) throw new Error("质检沙箱启动失败。请检查 Docker 执行镜像或 systemd 用户服务、Bubblewrap 及可用内存。");
    result.status=code===0 && !timeout && finished===opts.config.verify_commands.length && result.commands.every(c=>c.exit_code===0)?"passed":"failed";
    return result;
  } finally {
    clearTimeout(timer);clearTimeout(flushTimer);opts.signal.removeEventListener("abort",stop);
    if(stopping) await stopping;
    lines.close();
  }
}
