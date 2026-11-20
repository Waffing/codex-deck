import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, access, realpath, rm, lstat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createWriteStream } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Deployment, ServerProfile, StageInput, VerifyInput } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { resolveSafeWorkspacePath, openWorkspaceFile } from "../files/sandbox.js";
import { workspaceDirectory, workspaceFile } from "../security/paths.js";
import { command, fail, labelOutput, PortPool } from "./probe.js";
import { verifyUrl } from "./verifier.js";

interface Stored {
  last_verification_json:string|null;
  id:string;workspace_id:string;status:Deployment["status"];config_json:string;updated_at:string;created_at:string;
}
interface Config {
  start?:StageInput; archived?:boolean;
  mode:Deployment["mode"];port:number; previous_id:string|null; release:string; thread:string|null; image?:string; container?:string;
}
type Active = {workspace:string;port:number;child?:ChildProcess;entryPid?:number;container?:string;upstreamHost?:string;upstreamPort?:number;entry?:'node'|'python';log:string;ready:boolean};
export interface OpsOptions {
  dataDirectory:string; workspaceRoot?:string; portPool?:[number,number];
  proxyConfig?:{type:"caddy"|"nginx"; path:string};
  notifications?:{send(kind:string,payload:Record<string,unknown>):unknown};
}

async function ownsLoopback(pid:number,port:number) {
  if(process.platform==="win32") {
    const result=await command("netstat",["-ano","-p","tcp"]);
    return result.split(/\r?\n/).some(line=>{
      const cols=line.trim().split(/\s+/);
      return cols[1]==="127.0.0.1:"+port && cols[3]==="LISTENING" && cols[4]===String(pid);
    });
  }
  const result=await command("lsof",["-nP","-a","-p",String(pid),"-iTCP:"+port,"-sTCP:LISTEN"]).catch(()=>null);
  if(result) return result.includes("127.0.0.1:"+port+" (LISTEN)");
  const ss=await command("ss",["-ltnp"]).catch(()=>null);
  return !!ss?.split("\n").some(line=>line.includes("127.0.0.1:"+port+" ") && line.includes("pid="+pid+","));
}

export class Deployer {
  private active = new Map<string,Active>();
  private switching = new Set<string>();
  private readonly storageRoot:string;
  private readonly keep:number;
  constructor(readonly ctx:ServerContext,readonly files:WorkspaceFiles,readonly pool:PortPool,readonly options:OpsOptions,readonly root:string) {
    this.storageRoot=options.dataDirectory;
    this.keep=Number(process.env.CODEXDECK_RELEASE_KEEP ?? 5);
    if(!Number.isInteger(this.keep) || this.keep<2 || this.keep>100) throw new Error("CODEXDECK_RELEASE_KEEP must be between 2 and 100.");
  }
  private releasePath(config:Config,...parts:string[]) {
    const relative=path.isAbsolute(config.release) ? path.relative(this.options.dataDirectory,config.release) : config.release;
    if(!relative || relative===".." || relative.startsWith(".."+path.sep) || path.isAbsolute(relative)) throw fail(403,"Invalid release directory.");
    return path.join(relative,...parts);
  }
  rows() { return this.ctx.native.prepare("SELECT * FROM deployments ORDER BY created_at DESC").all() as Stored[]; }
  runningCount() { return [...this.active.values()].filter(instance=>instance.ready).length; }
  get(id:string,workspace?:string) {
    const row=this.ctx.native.prepare("SELECT * FROM deployments WHERE id=?").get(id) as Stored|undefined;
    if(!row || (workspace && workspace!==row.workspace_id)) throw fail(404,"Deployment not found.");
    return row;
  }
  dto(row:Stored):Deployment {
    const config:Config=JSON.parse(row.config_json);
    return {id:row.id,workspace_id:row.workspace_id,status:row.status,mode:config.mode,port:config.port,archived:config.archived ?? false,
      preview_url:"/preview/"+config.port+"/",live_url:row.status==="live" ? "/live/"+row.workspace_id+"/" : null,
      last_verification:row.last_verification_json ? JSON.parse(row.last_verification_json) : null,
      previous_id:config.previous_id,created_at:row.created_at,updated_at:row.updated_at};
  }
  private save(id:string,status:Deployment["status"],config?:Config) {
    this.ctx.native.prepare("UPDATE deployments SET status=?,updated_at=?,config_json=COALESCE(?,config_json) WHERE id=?")
      .run(status,new Date().toISOString(),config && JSON.stringify(config) || null,id);
  }
  private note(kind:string,id:string,workspace:string) {
    void Promise.resolve(this.options.notifications?.send(kind,{deployment_id:id,workspace_id:workspace})).catch(()=>{});
  }
  private async snapshot(sourceRoot:string,source:string,dest:string) {
    let entries=0,files=0,bytes=0;
    const copy=async(relative:string):Promise<void>=>{
      const src=await resolveSafeWorkspacePath(sourceRoot,path.join(source,relative));
      for(const entry of await readdir(src,{withFileTypes:true})) {
        if(entry.name.startsWith(".") || entry.name==="node_modules") continue;
        if(entry.isSymbolicLink()) throw fail(403,"Static releases cannot include symbolic links.");
        if(++entries>20000) throw fail(413,"Release exceeds 20,000 entries.");
        const sub=path.join(relative,entry.name);
        const srcPath=await resolveSafeWorkspacePath(sourceRoot,path.join(source,sub));
        if(entry.isDirectory()) {
          await workspaceDirectory(this.storageRoot,path.join(dest,sub),true);
          await copy(sub);
        } else if(entry.isFile()) {
          const input=await openWorkspaceFile(sourceRoot,path.relative(sourceRoot,srcPath));
          try {
            files++;
            const limit=512*1024*1024;
            if(bytes+(await input.stat()).size>limit) throw fail(413,"Release exceeds 512 MiB.");
            const budget=new Transform({transform(chunk,_encoding,done){
              bytes+=chunk.length;
              if(bytes>limit) done(fail(413,"Release exceeds 512 MiB."));
              else done(null,chunk);
            }});
            await pipeline(input.createReadStream(),budget,createWriteStream(await workspaceFile(this.storageRoot,path.join(dest,sub)),{flags:"wx",mode:0o644}));
          } finally { await input.close(); }
        }
      }
    };
    await copy("");
    if(!files) throw fail(400,"Static release is empty.");
  }
  private async startLocal(active:Active,dir:string) {
    const ext=import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker=fileURLToPath(new URL("./local-worker"+ext,import.meta.url));
    const env:NodeJS.ProcessEnv={};
    for(const key of ["SystemRoot","WINDIR","TEMP","TMP"]) if(process.env[key]) env[key]=process.env[key];
    const child=fork(worker,[dir,String(active.port)],{cwd:dir,env,execArgv:ext===".ts"?["--import",import.meta.resolve("tsx")]:[],
      stdio:["ignore","pipe","pipe","ipc"],serialization:"json"});
    active.child=child;
    this.captureLogs(active,child);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(fail(504,"Staging process did not become ready.")),12_000);
      child.once("message",message=>{clearTimeout(timer);if(message==="ready") resolve(); else reject(fail(502,"Invalid readiness signal."));});
      child.once("error",()=>{clearTimeout(timer);reject(fail(502,"Could not start local process."));});
      child.once("exit",()=>{clearTimeout(timer);reject(fail(502,"Staging process exited."));});
    });
  }
  private async startEntry(active:Active,dir:string,entry:string,args:string[]) {
    const script=await resolveSafeWorkspacePath(dir,entry);
    const python=path.extname(script)===".py";
    active.entry=python ? 'python' : 'node';
    if(!python && !/\.[cm]?js$/.test(script)) throw fail(400,"Choose a Node or Python entry file.");
    const env:NodeJS.ProcessEnv={PORT:String(active.port),HOST:"127.0.0.1"};
    for(const key of ["SystemRoot","WINDIR","PATH","TEMP","TMP"]) if(process.env[key]) env[key]=process.env[key];
    const flags=process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission";
    let executable=process.execPath;
    let argv=[flags,"--allow-fs-read="+dir,script,...args];
    if(python) {
      if(process.platform!=="linux") throw fail(400,"Use a Python container on this host or a Linux host with bubblewrap.");
      await command("bwrap",["--version"]).catch(()=>{throw fail(400,"Local Python requires bubblewrap or a container.");});
      executable="bwrap";
      argv=["--unshare-all","--share-net","--die-with-parent","--new-session","--cap-drop","ALL",
        "--proc","/proc","--dev","/dev","--tmpfs","/tmp"];
      for(const system of ["/usr","/bin","/lib","/lib64"]) {
        if(await access(system).then(()=>true).catch(()=>false)) argv.push("--ro-bind",system,system);
      }
      argv.push("--ro-bind",dir,"/app","--chdir","/app","/usr/bin/python3","-I","-B","/app/"+path.relative(dir,script),...args);
    }
    const ext=import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker=fileURLToPath(new URL("./entry-worker"+ext,import.meta.url));
    const child=fork(worker,[executable,...argv],
      {cwd:dir,env,windowsHide:true,execArgv:ext===".ts"?["--import",import.meta.resolve("tsx")]:[],stdio:["ignore","pipe","pipe","ipc"]});
    active.child=child;
    child.on("message",pid=>{ if(typeof pid==="number") active.entryPid=pid; });
    let failed=false;
    child.on("error",()=>{failed=true;});
    this.captureLogs(active,child);
    for(let i=0;i<40;i++) {
      if(failed || child.exitCode!==null) throw fail(502,"Managed entry exited before becoming ready.");
      if(await this.ownsEntryPort(active)) return;
      await delay(150);
    }
    throw fail(504,"The managed entry must listen on its assigned loopback port.");
  }
  private captureLogs(active:Active,child:ChildProcess) {
    for(const source of ["stdout","stderr"] as const) {
      const stream=child[source];
      let tail="",discard=false;
      const append=(line:string)=>{
        const masked=this.ctx.masker.maskString(line);
        active.log=(active.log+labelOutput(source,masked)+"\n").slice(-64*1024);
      };
      stream?.setEncoding("utf8");
      stream?.on("data",(chunk:string)=>{
        const lines=chunk.split("\n");
        for(let i=0;i<lines.length;i++) {
          if(!discard) tail+=lines[i];
          if(tail.length>64*1024) {discard=true;tail="";}
          if(i<lines.length-1) {append(discard?"[oversized log line omitted]":tail);tail="";discard=false;}
        }
      });
      stream?.once("end",()=>{if(tail || discard) append(discard?"[oversized log line omitted]":tail);});
    }
  }
  private async ownsEntryPort(active:Active) {
    if(!active.entryPid) return false;
    const pids=[active.entryPid];
    if(active.entry==="python") {
      for(let i=0;i<pids.length && i<64;i++) {
        const descendants=await readFile("/proc/"+pids[i]+"/task/"+pids[i]+"/children","utf8").catch(()=>"");
        pids.push(...descendants.trim().split(/\s+/).map(Number).filter(Boolean));
      }
    }
    for(const pid of pids) if(await ownsLoopback(pid,active.port)) return true;
    return false;
  }
  private async hostReleasePath(local:string) {
    if(!process.env.CODEXDECK_DEPLOYMENT_NETWORK) return local;
    const mounts=JSON.parse(await command("docker",["inspect","--format","{{json .Mounts}}",hostname()])) as {Destination:string;Source:string;Type:string}[];
    const mount=mounts.filter(m=>m.Type==="bind" && (local===m.Destination || local.startsWith(m.Destination+"/")))
      .sort((a,b)=>b.Destination.length-a.Destination.length)[0];
    if(!mount || !path.posix.isAbsolute(mount.Source)) throw fail(409,"A bind-mounted data directory is required for managed releases.");
    return path.posix.join(mount.Source,path.posix.relative(mount.Destination,local));
  }
  private async startContainer(id:string,config:Config,input:StageInput,active:Active) {
    const name="codexdeck-"+id;
    const python=input.entry && path.extname(input.entry)===".py";
    const requestedImage=input.image ?? (input.entry ? (python?"python:3.12-slim":"node:22-bookworm-slim") : "nginx:alpine");
    const image=config.image ?? requestedImage;
    const labels={"codexdeck.managed":"true","codexdeck.deployment":id};
    const internal=input.image || input.entry ? input.container_port : 8080;
    const network=process.env.CODEXDECK_DEPLOYMENT_NETWORK;
    active.upstreamHost=network ? name : "127.0.0.1";
    active.upstreamPort=network ? internal : config.port;
    if([22,80,443,this.pool.controlPort()].includes(internal)) throw fail(403,"Container port is protected.");
    const files=await workspaceDirectory(this.storageRoot,this.releasePath(config,"content"),true);
    const volumes:{source:string;target:string}[]=[];
    let entryCommand:string[]|undefined;
    if(input.entry) {
      if(!python && !/\.[cm]?js$/.test(input.entry)) throw fail(400,"Choose a Node or Python entry file.");
      const script=await openWorkspaceFile(files,input.entry);await script.close();
      const relative=path.relative(files,await resolveSafeWorkspacePath(files,input.entry)).split(path.sep).join("/");
      entryCommand=[...(python?["python3","-I","-B"]:["node"]),"/app/"+relative,...input.args];
      volumes.push({source:await this.hostReleasePath(files),target:"/app"});
    } else if(!input.image) {
      const conf=await workspaceFile(this.storageRoot,this.releasePath(config,"static.conf"));
      await writeFile(conf,"server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri $uri/ =404; } }");
      volumes.push({source:await this.hostReleasePath(files),target:"/usr/share/nginx/html"},
        {source:await this.hostReleasePath(conf),target:"/etc/nginx/conf.d/default.conf"});
    }
    const uid=process.getuid?.() || 1000,gid=process.getgid?.() || 1000;
    const limits={cpus:1,mem_limit:"512m",pids_limit:128};
    const temp=["/tmp:size=64m",`/var/cache/nginx:size=32m,uid=${uid},gid=${gid}`,`/var/run:size=4m,uid=${uid},gid=${gid}`];
    // Compose receives only our generated spec. User Compose files never acquire host volumes or Docker socket access.
    if(config.mode==="compose") {
      const manifest=await workspaceFile(this.storageRoot,this.releasePath(config,"compose.json"));
      // Prefer the registry digest for Compose. Locally built images need a
      // named reference, and must still resolve to the recorded image ID.
      let composeImage=image;
      if(config.image?.startsWith("sha256:")) {
        const digests=JSON.parse(await command("docker",["image","inspect","--format","{{json .RepoDigests}}",config.image])) as string[]|null;
        composeImage=digests?.[0] ?? requestedImage;
        if(await command("docker",["image","inspect","--format","{{.Id}}",composeImage])!==config.image)
          throw fail(409,"The original local image tag has changed; re-stage the new version.");
      }
      const spec={services:{app:{image:composeImage,...(composeImage!==image?{pull_policy:"never"}:{}),container_name:name,labels,
        ...(network ? {networks:{codexdeck:{aliases:[name]}}} : {ports:["127.0.0.1:"+config.port+":"+internal]}),
        user:`${uid}:${gid}`,
        ...(entryCommand ? {working_dir:"/app",command:entryCommand,environment:{HOST:"0.0.0.0",PORT:String(internal)}} : {}),
        volumes:volumes.map(m=>({type:"bind",...m,read_only:true,bind:{create_host_path:false}})),
        ...limits,restart:"unless-stopped",security_opt:["no-new-privileges:true"],cap_drop:["ALL"],tmpfs:temp,read_only:true}},
        ...(network ? {networks:{codexdeck:{external:true,name:network}}} : {})};
      await writeFile(manifest,JSON.stringify(spec));
      await command("docker",["compose","-p",name,"-f",manifest,"up","-d"],{timeout:120000});
    } else {
      const args=["run","--detach","--name",name,"--label","codexdeck.managed=true","--label","codexdeck.deployment="+id,"--read-only",
        "--security-opt","no-new-privileges","--cap-drop","ALL","--cpus","1","--memory","512m","--pids-limit","128","--restart","unless-stopped"];
      for(const mount of temp) args.push("--tmpfs",mount);
      args.push("--user",`${uid}:${gid}`);
      if(entryCommand) args.push("--workdir","/app","--env","PORT="+internal,"--env","HOST=0.0.0.0");
      if(network) args.push("--network",network,"--network-alias",name);
      else args.push("--publish","127.0.0.1:"+config.port+":"+internal);
      for(const mount of volumes) {
        if(mount.source.includes(",")) throw fail(400,"Choose a data directory without commas or use Compose.");
        args.push("--mount",`type=bind,source=${mount.source},target=${mount.target},readonly`);
      }
      await command("docker",[...args,image,...(entryCommand ?? [])],{timeout:120000});
    }
    config.container=name;
    config.image=await command("docker",["inspect","--format","{{.Image}}",name]);
    for(let i=0;i<40;i++) {
      try {
        const r=await fetch("http://"+active.upstreamHost+":"+active.upstreamPort+"/",{redirect:"manual",signal:AbortSignal.timeout(400)});
        await r.body?.cancel();return;
      } catch { await delay(200); }
    }
    throw fail(504,"Staging container did not become ready.");
  }
  async stage(workspace:string,thread:string|null,input:StageInput,profile:ServerProfile) {
    const ws=await this.files.getRoot(workspace);
    const managed=!!process.env.CODEXDECK_DEPLOYMENT_NETWORK || !!process.env.DOCKER_HOST;
    const mode=input.mode==="auto" ? profile.docker_available || managed ? (profile.runtimes.compose ? "compose" : "docker") : "local" : input.mode;
    if(mode==="local" && process.env.NODE_ENV==="production" && process.env.CODEXDECK_ALLOW_LOCAL_DEPLOYMENTS!=="true") {
      throw fail(403,"Local deployments are disabled in production; use Docker or Compose.");
    }
    if(input.entry && mode==="local" && managed) throw fail(403,"Managed workspace entries must use an isolated container.");
    if(input.entry && input.image) throw fail(400,"Choose an entry or a prebuilt image.");
    if(mode==="local" && input.image) throw fail(400,"An image requires Docker or Compose.");
    const id=randomUUID();
    const release=path.join("releases",id);
    await workspaceDirectory(this.storageRoot,release,true);
    const port=input.reserved_port ?? await this.pool.allocate(workspace);
    await this.pool.claim(workspace,port);
    const active={workspace,port,log:"",ready:false} as Active;
    const config:Config={mode,port,release,thread,previous_id:null,start:input};
    const now=new Date().toISOString();
    this.ctx.native.prepare("INSERT INTO deployments(id,workspace_id,status,config_json,created_at,updated_at) VALUES(?,?,'starting',?,?,?)")
      .run(id,workspace,JSON.stringify(config),now,now);
    this.active.set(id,active);
    try {
      const content=path.join(release,"content");
      await workspaceDirectory(this.storageRoot,content,true);
      if(!input.image) await this.snapshot(ws,input.entry && input.public_dir==="public" ? "." : input.public_dir,content);
      await this.launch(id,config,input,active,await workspaceDirectory(this.storageRoot,content));
      this.save(id,"staging",config);
      await this.prune(workspace).catch(()=>this.note("deployment_cleanup_failed",id,workspace));
      return this.dto(this.get(id));
    } catch(error) {
      await this.stopInstance(id);
      this.save(id,"failed",config);this.note("deployment_exception",id,workspace);
      await this.prune(workspace).catch(()=>this.note("deployment_cleanup_failed",id,workspace));
      if(error instanceof Error && "statusCode" in error) throw error;
      throw fail(502,"Staging failed; check the runtime and public directory.");
    }
  }
  private async containerIdentity(id:string,name:string) {
    try {
      const actual=await command("docker",["container","inspect","--format",'{{index .Config.Labels "codexdeck.deployment"}} {{index .Config.Labels "codexdeck.managed"}} {{.State.Running}}',name]);
      if(!actual.startsWith(id+" true ")) throw fail(409,"Container ownership differs from the deployment.");
      return actual;
    } catch(error) {
      if(/\bno such (?:object|container)\b/i.test(String((error as {stderr?:string}).stderr))) return "";
      throw error;
    }
  }
  private async launch(id:string,config:Config,input:StageInput,active:Active,content:string) {
    if(config.mode==="local" && input.entry) {
      if(process.env.CODEXDECK_DEPLOYMENT_NETWORK || process.env.DOCKER_HOST) throw fail(403,"Re-stage this entry in an isolated container.");
      await this.startEntry(active,content,input.entry,input.args);
    } else if(config.mode==="local") await this.startLocal(active,content);
    else {
      active.container="codexdeck-"+id;
      await this.startContainer(id,config,input,active);
    }
    active.ready=true;
    active.child?.once("exit",()=>{
      if(this.active.get(id)!==active) return;
      this.active.delete(id);this.pool.release(active.port);this.save(id,"failed");
      void this.saveLog(this.get(id),active.log).catch(()=>{});
      this.note("deployment_exception",id,active.workspace);
    });
  }
  async restart(id:string) {
    const row=this.get(id), config:Config=JSON.parse(row.config_json);
    if(config.archived) throw fail(410,"Release snapshot expired; stage the project again.");
    if(!config.start) throw fail(409,"Stage this legacy deployment once to record its launch configuration.");
    if(row.status==="starting" || this.switching.has(row.workspace_id)) throw fail(409,"Deployment transition in progress.");
    this.switching.add(row.workspace_id);
    try {
      const content=await workspaceDirectory(this.storageRoot,this.releasePath(config,"content"));
      await this.stopInstance(id);
      const port=await this.pool.allocate(row.workspace_id);
      await this.pool.claim(row.workspace_id,port);
      config.port=port;
      this.save(id,"starting",config);
      const active={workspace:row.workspace_id,port,log:"",ready:false} as Active;
      this.active.set(id,active);
      await this.launch(id,config,config.start,active,content);
      this.save(id,row.status==="live" ? "live" : "staging",config);
      return this.dto(this.get(id));
    } catch(error) {
      if(this.active.has(id)) await this.stopInstance(id);
      this.save(id,"failed"); this.note("deployment_exception",id,row.workspace_id);
      throw error;
    } finally { this.switching.delete(row.workspace_id); }
  }
  async runningPort(port:number,workspace?:string) {
    if(!this.pool.safe(port)) throw fail(403,"Unmanaged preview port.");
    for(const [id,active] of this.active) {
      if(active.port!==port || !active.ready || (workspace && active.workspace!==workspace)) continue;
      const row=this.get(id);
      if(!["staging","live","rolled_back"].includes(row.status)) break;
      if(active.container && !(await this.containerIdentity(id,active.container)).endsWith("true true")) break;
      if(active.child && (active.child.exitCode!==null || active.child.killed)) break;
      if(active.entry && !(await this.ownsEntryPort(active))) break;
      return port;
    }
    throw fail(403,"Unmanaged preview port.");
  }
  upstream(port:number) {
    const active=[...this.active.values()].find(instance=>instance.port===port&&instance.ready);
    if(!active) throw fail(403,"Unmanaged preview port.");
    return {host:active.upstreamHost??"127.0.0.1",port:active.upstreamPort??port};
  }
  async livePort(workspace:string) {
    const row=this.rows().find(r=>r.workspace_id===workspace && r.status==="live");
    if(!row) throw fail(404,"Workspace has no live deployment.");
    return this.runningPort(this.dto(row).port,workspace);
  }
  private async savedLog(config:Config) {
    if(!config.release || config.archived) return "";
    try {return await readFile(await workspaceFile(this.storageRoot,this.releasePath(config,"deployment.log")),"utf8");}
    catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") return "";throw error;}
  }
  private async saveLog(row:Stored,content:string) {
    const config:Config=JSON.parse(row.config_json);
    const file=await workspaceFile(this.storageRoot,this.releasePath(config,"deployment.log"));
    await writeFile(file,this.ctx.masker.maskString(content).slice(-64*1024),{mode:0o600});
  }
  async logs(id:string,workspace?:string) {
    const row=this.get(id,workspace);
    const active=this.active.get(row.id);
    const config:Config=JSON.parse(row.config_json);
    const text=active?.container && await this.containerIdentity(id,active.container)
      ? await command("docker",["logs","--tail","200",active.container],{logs:true}) : active?.log ?? await this.savedLog(config);
    return this.ctx.masker.maskString(text);
  }
  async verify(input:VerifyInput,workspace?:string,thread:string|null=null) {
    const row=this.get(input.deployment_id,workspace);
    const turn=thread ? this.ctx.native.prepare("SELECT id FROM tasks WHERE thread_id=? AND workspace_id=? AND status='running'").pluck().get(thread,row.workspace_id) as string|undefined : undefined;
    const port=await this.runningPort(this.dto(row).port,row.workspace_id);
    const upstream=this.upstream(port);
    const report=await verifyUrl(input,port,await this.logs(row.id),row.workspace_id,thread,turn ?? null,this.files,this.ctx.masker,
      "http://"+upstream.host+":"+upstream.port);
    this.ctx.native.prepare("UPDATE deployments SET last_verification_json=? WHERE id=?")
      .run(JSON.stringify(report),row.id);
    return report;
  }
  private async restore(row:Stored) {
    const config:Config=JSON.parse(row.config_json);
    const previous=config.previous_id;
    if(previous) {
      const active=this.active.get(previous);
      if(!active?.ready) throw fail(409,"Preceding snapshot is no longer running.");
      await this.runningPort(active.port,row.workspace_id);
    }
    this.ctx.native.transaction(()=>{this.save(row.id,"rolled_back");if(previous) this.save(previous,"live");})();
  }
  private async validateProxy() {
    const proxy=this.options.proxyConfig;
    if(!proxy) return;
    const file=await workspaceFile(this.options.dataDirectory,proxy.path);
    // Validation only. The stable ingress forwards to /live/<workspace>/, whose target is transactional in SQLite.
    try { await command(proxy.type,proxy.type==="nginx"?["-t","-c",file]:["validate","--config",file]); }
    catch { throw fail(409,"Managed ingress configuration failed syntax validation."); }
  }
  async promote(input:VerifyInput,workspace?:string,thread:string|null=null) {
    const row=this.get(input.deployment_id,workspace);
    if(this.switching.has(row.workspace_id)) throw fail(409,"A live switch is already in progress.");
    const config:Config=JSON.parse(row.config_json);
    if(row.status==="live") return {deployment:this.dto(row),verification:await this.verify(input,row.workspace_id,thread)};
    this.switching.add(row.workspace_id);
    try {
      await this.runningPort(config.port,row.workspace_id);
      await this.validateProxy();
      const report=await this.verify(input,row.workspace_id,thread);
      if(!report.ok) {
        this.save(row.id,"rolled_back");
        this.note("deployment_exception",row.id,row.workspace_id);
      } else {
        const older=this.rows().find(r=>r.workspace_id===row.workspace_id && r.status==="live");
        config.previous_id=older?.id ?? null;
        this.ctx.native.transaction(()=>{if(older) this.save(older.id,"staging");this.save(row.id,"live",config);})();
      }
      return {deployment:this.dto(this.get(row.id)),verification:report};
    } finally { this.switching.delete(row.workspace_id); }
  }
  async rollback(id:string,workspace?:string) {
    const row=this.get(id,workspace);
    if(row.status!=="live" || this.switching.has(row.workspace_id)) throw fail(409,"Only a stable live deployment can be rolled back.");
    this.switching.add(row.workspace_id);
    try {await this.restore(row);return this.dto(this.get(id));}
    finally {this.switching.delete(row.workspace_id);}
  }
  async stop(id:string) {
    const row=this.get(id);
    if(this.switching.has(row.workspace_id)) throw fail(409,"Live switch in progress.");
    this.switching.add(row.workspace_id);
    try { return await this.stopInstance(id); }
    finally { this.switching.delete(row.workspace_id); }
  }
  private async stopInstance(id:string,preserveState=false) {
    const row=this.get(id);
    const active=this.active.get(id);
    if(active) {
      const text=await this.logs(id).catch(()=>active.log);
      await this.saveLog(row,text).catch(()=>this.note("deployment_log_write_failed",id,row.workspace_id));
    }
    if(active?.child && active.child.exitCode===null) {
      const child=active.child;
      this.active.delete(id);
      await new Promise<void>(resolve=>{
        const force=setTimeout(()=>child.kill("SIGKILL"),2000).unref();
        child.once("exit",()=>{clearTimeout(force);resolve();});
        if(child.connected) child.disconnect();
        else if(!child.kill()){clearTimeout(force);resolve();}
      });
    }
    if(active?.container && await this.containerIdentity(id,active.container)) {
      const config:Config=JSON.parse(row.config_json);
      // Compose `down` selects by project label. Only stop the verified container.
      await command("docker",["rm","-f",active.container]);
      if(config.mode==="compose" && !process.env.CODEXDECK_DEPLOYMENT_NETWORK) {
        const network=active.container+"_default";
        const owner=await command("docker",["network","inspect","--format",'{{index .Labels "com.docker.compose.project"}}',network]).catch(()=>"");
        if(owner===active.container) await command("docker",["network","rm",network]).catch(()=>{});
      }
    }
    this.active.delete(id);
    if(active) this.pool.release(active.port);
    if(!preserveState) this.save(id,"stopped");
    return this.dto(this.get(id));
  }
  private async prune(workspace:string) {
    if(this.switching.has(workspace)) return;
    this.switching.add(workspace);
    try {
      const rows=this.rows().filter(row=>row.workspace_id===workspace);
      const live=rows.find(row=>row.status==="live");
      const retained=new Set([live?.id, live && this.dto(live).previous_id].filter(Boolean));
      const old=rows.filter(row=>!retained.has(row.id) && row.status!=="starting" && !JSON.parse(row.config_json).archived);
      // Preserve the newest candidates in addition to live and its immediately preceding rollback.
      for(const row of old.slice(this.keep)) {
        const config:Config=JSON.parse(row.config_json);
        if(!/^[0-9a-f-]{36}$/i.test(row.id) || config.release!==path.join("releases",row.id)) continue;
        const expected=path.resolve(this.storageRoot,config.release);
        const meta=await lstat(expected).catch(error=>{if(error.code==="ENOENT") return null;throw error;});
        if(meta && (meta.isSymbolicLink() || (await realpath(expected))!==expected)) continue;
        await this.stopInstance(row.id);
        if(meta) await rm(expected,{recursive:true,force:false});
        this.save(row.id,"stopped",{...config,archived:true});
      }
    } finally { this.switching.delete(workspace); }
  }
  async recover() {
    // Adopt existing containers before assigning local ports to new workers.
    const rows=this.rows().filter(r=>!this.active.has(r.id) && ["starting","live","staging","rolled_back"].includes(r.status));
    const pending:Stored[]=[];
    for(const row of rows) {
      const config:Config=JSON.parse(row.config_json);
      const name="codexdeck-"+row.id;
      if(config.mode!=="local" && !config.archived) {
        let identity;
        try {identity=await this.containerIdentity(row.id,name);}
        catch {this.note("deployment_recovery_unavailable",row.id,row.workspace_id);continue;}
        if(identity.endsWith("true true") && config.start && row.status!=="starting") {
          try {this.pool.adopt(config.port);} catch {this.note("deployment_recovery_conflict",row.id,row.workspace_id);continue;}
          const network=process.env.CODEXDECK_DEPLOYMENT_NETWORK;
          this.active.set(row.id,{workspace:row.workspace_id,port:config.port,ready:true,log:"",container:name,
            upstreamHost:network ? name : "127.0.0.1",
            upstreamPort:network ? (config.start.image || config.start.entry ? config.start.container_port : 8080) : config.port});
          continue;
        }
        if(identity) this.active.set(row.id,{workspace:row.workspace_id,port:config.port,ready:false,log:"",container:name});
      }
      pending.push(row);
    }
    for(const row of pending) {
      const config:Config=JSON.parse(row.config_json);
      const active:Active={workspace:row.workspace_id,port:config.port,ready:false,log:""};
      try {
        if(this.active.has(row.id)) await this.stopInstance(row.id,true);
        if(!config.start || config.archived) throw new Error("Missing staged snapshot");
        if(row.status==="starting") throw new Error("Interrupted during staging");
        const content=await workspaceDirectory(this.storageRoot,this.releasePath(config,"content"));
        const port=await this.pool.allocate(row.workspace_id);
        await this.pool.claim(row.workspace_id,port);
        active.port=port; config.port=port;
        this.active.set(row.id,active);
        await this.launch(row.id,config,config.start,active,content);
        this.save(row.id,row.status,config);
      } catch {
        if(this.active.has(row.id)) await this.stopInstance(row.id,true).catch(()=>{});
        this.save(row.id,"failed");this.note("deployment_exception",row.id,row.workspace_id);
      }
    }
  }
  async close() {
    this.pool.close();
    for(const [id,instance] of this.active) {
      if(instance.container) {this.active.delete(id);continue;}
      await this.stopInstance(id,true);
    }
  }
}
