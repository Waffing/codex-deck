import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, readdir, readFile, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Deployment, ServerProfile, StageInput, VerifyInput } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { resolveSafeWorkspacePath, ensureDirectory } from "../files/sandbox.js";
import { workspaceDirectory, workspaceFile } from "../security/paths.js";
import { command, fail, PortPool } from "./probe.js";
import { verifyUrl } from "./verifier.js";

interface Stored {
  last_verification_json:string|null;
  id:string;workspace_id:string;status:Deployment["status"];config_json:string;updated_at:string;created_at:string;
}
interface Config {
  start?:StageInput;
  mode:Deployment["mode"];port:number; previous_id:string|null; release:string; thread:string|null; image?:string; container?:string;
}
type Active = {workspace:string;port:number;child?:ChildProcess;container?:string;upstreamHost?:string;upstreamPort?:number;entry?:'node'|'python';log:string;ready:boolean};
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
  constructor(readonly ctx:ServerContext,readonly files:WorkspaceFiles,readonly pool:PortPool,readonly options:OpsOptions,readonly root:string) {
    this.storageRoot=options.dataDirectory;
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
    return {id:row.id,workspace_id:row.workspace_id,status:row.status,mode:config.mode,port:config.port,
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
    let count=0;
    const copy=async(relative:string):Promise<void>=>{
      const src=await resolveSafeWorkspacePath(sourceRoot,path.join(source,relative));
      for(const entry of await readdir(src,{withFileTypes:true})) {
        if(entry.name.startsWith(".") || entry.name==="node_modules") continue;
        if(entry.isSymbolicLink()) throw fail(403,"Static releases cannot include symbolic links.");
        const sub=path.join(relative,entry.name);
        const srcPath=await resolveSafeWorkspacePath(sourceRoot,path.join(source,sub));
        if(entry.isDirectory()) {
          await workspaceDirectory(this.storageRoot,path.join(dest,sub),true);
          await copy(sub);
        } else if(entry.isFile()) {
          await copyFile(srcPath,await workspaceFile(this.storageRoot,path.join(dest,sub)));
          count++;
        }
      }
    };
    await copy("");
    if(!count) throw fail(400,"Static release is empty.");
  }
  private async startLocal(active:Active,dir:string) {
    const ext=import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const worker=fileURLToPath(new URL("./local-worker"+ext,import.meta.url));
    const env:NodeJS.ProcessEnv={};
    for(const key of ["SystemRoot","WINDIR","TEMP","TMP"]) if(process.env[key]) env[key]=process.env[key];
    const child=fork(worker,[dir,String(active.port)],{cwd:dir,env,execArgv:ext===".ts"?["--import",import.meta.resolve("tsx")]:[],
      stdio:["ignore","pipe","pipe","ipc"],serialization:"json"});
    active.child=child;
    const append=(chunk:Buffer)=>{active.log=(active.log+chunk.toString()).slice(-64*1024);};
    child.stdout?.on("data",append);child.stderr?.on("data",append);
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
    const child=spawn(executable,argv,
      {cwd:dir,env,shell:false,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    active.child=child;
    let failed=false;
    child.on("error",()=>{failed=true;});
    const append=(chunk:Buffer)=>{active.log=(active.log+chunk.toString()).slice(-64*1024);};
    child.stdout.on("data",append);child.stderr.on("data",append);
    for(let i=0;i<40;i++) {
      if(failed || child.exitCode!==null) throw fail(502,"Managed entry exited before becoming ready.");
      if(await this.ownsEntryPort(active)) return;
      await delay(150);
    }
    throw fail(504,"The managed entry must listen on its assigned loopback port.");
  }
  private async ownsEntryPort(active:Active) {
    if(!active.child?.pid) return false;
    const pids=[active.child.pid];
    if(active.entry==="python") {
      for(let i=0;i<pids.length && i<64;i++) {
        const descendants=await readFile("/proc/"+pids[i]+"/task/"+pids[i]+"/children","utf8").catch(()=>"");
        pids.push(...descendants.trim().split(/\s+/).map(Number).filter(Boolean));
      }
    }
    for(const pid of pids) if(await ownsLoopback(pid,active.port)) return true;
    return false;
  }
  private async startContainer(id:string,config:Config,input:StageInput,active:Active) {
    const name="codexdeck-"+id;
    const image=config.image ?? input.image ?? "nginx:alpine";
    const labels={"codexdeck.managed":"true","codexdeck.deployment":id};
    const internal=input.image ? input.container_port : 8080;
    const network=process.env.CODEXDECK_DEPLOYMENT_NETWORK;
    active.upstreamHost=network ? name : "127.0.0.1";
    active.upstreamPort=network ? internal : config.port;
    if([22,80,443,this.pool.controlPort()].includes(internal)) throw fail(403,"Container port is protected.");
    const files=await workspaceDirectory(this.storageRoot,this.releasePath(config,"content"),true);
    const volumes:string[]=[];
    if(!input.image) {
      const conf=await workspaceFile(this.storageRoot,this.releasePath(config,"static.conf"));
      await writeFile(conf,"server { listen 8080; root /usr/share/nginx/html; location / { try_files $uri $uri/ =404; } }");
      volumes.push(files+":/usr/share/nginx/html:ro",conf+":/etc/nginx/conf.d/default.conf:ro");
    }
    // Compose receives only our generated spec. User Compose files never acquire host volumes or Docker socket access.
    if(config.mode==="compose") {
      const manifest=await workspaceFile(this.storageRoot,this.releasePath(config,"compose.json"));
      const spec={services:{app:{image,container_name:name,labels,
        ...(network ? {networks:{codexdeck:{aliases:[name]}}} : {ports:["127.0.0.1:"+config.port+":"+internal]}),
        volumes,security_opt:["no-new-privileges:true"],cap_drop:["ALL"],tmpfs:["/tmp","/var/cache/nginx","/var/run"],read_only:true}},
        ...(network ? {networks:{codexdeck:{external:true,name:network}}} : {})};
      await writeFile(manifest,JSON.stringify(spec));
      await command("docker",["compose","-p",name,"-f",manifest,"up","-d"],{timeout:120000});
    } else {
      const args=["run","--detach","--name",name,"--label","codexdeck.managed=true","--label","codexdeck.deployment="+id,"--read-only",
        "--security-opt","no-new-privileges","--cap-drop","ALL","--tmpfs","/tmp","--tmpfs","/var/cache/nginx","--tmpfs","/var/run"];
      if(network) args.push("--network",network,"--network-alias",name);
      else args.push("--publish","127.0.0.1:"+config.port+":"+internal);
      for(const mount of volumes) args.push("--volume",mount);
      await command("docker",[...args,image],{timeout:120000});
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
    const mode=input.mode==="auto" ? profile.docker_available && !input.entry ? (profile.runtimes.compose ? "compose" : "docker") : "local" : input.mode;
    if(input.entry && process.platform==="win32" && path.extname(input.entry)===".py") throw fail(400,"Use a Python container on this host.");
    if(input.entry && mode!=="local") throw fail(400,"Use an image for container deployments.");
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
      return this.dto(this.get(id));
    } catch(error) {
      await this.stop(id);
      this.save(id,"failed",config);this.note("deployment_exception",id,workspace);
      if(error instanceof Error && "statusCode" in error) throw error;
      throw fail(502,"Staging failed; check the runtime and public directory.");
    }
  }
  private async containerIdentity(id:string,name:string) {
    return command("docker",["inspect","--format",'{{index .Config.Labels "codexdeck.deployment"}} {{index .Config.Labels "codexdeck.managed"}} {{.State.Running}}',name])
      .then(v=>v.startsWith(id+" true ") ? v : "").catch(()=>"");
  }
  private async launch(id:string,config:Config,input:StageInput,active:Active,content:string) {
    if(input.entry) await this.startEntry(active,content,input.entry,input.args);
    else if(config.mode==="local") await this.startLocal(active,content);
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
    if(!config.release) return "";
    const file=await workspaceFile(this.storageRoot,this.releasePath(config,"deployment.log"));
    try {return await readFile(file,"utf8");}
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
      ? await command("docker",["logs","--tail","200",active.container]) : active?.log ?? await this.savedLog(config);
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
      .run(JSON.stringify({ok:report.ok,checked_at:new Date().toISOString()}),row.id);
    return report;
  }
  private restore(row:Stored) {
    const config:Config=JSON.parse(row.config_json);
    const previous=config.previous_id;
    if(previous && !this.active.get(previous)?.ready) throw fail(409,"Preceding snapshot is no longer running.");
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
      const older=this.rows().find(r=>r.workspace_id===row.workspace_id && r.status==="live");
      config.previous_id=older?.id ?? null;
      this.ctx.native.transaction(()=>{if(older) this.save(older.id,"staging");this.save(row.id,"live",config);})();
      try {
        const report=await this.verify(input,row.workspace_id,thread);
        if(!report.ok) { this.restore(this.get(row.id)); this.note("deployment_exception",row.id,row.workspace_id); }
        return {deployment:this.dto(this.get(row.id)),verification:report};
      } catch(error) { this.restore(this.get(row.id));this.note("deployment_exception",row.id,row.workspace_id);throw error; }
    } finally { this.switching.delete(row.workspace_id); }
  }
  rollback(id:string,workspace?:string) {
    const row=this.get(id,workspace);
    if(row.status!=="live" || this.switching.has(row.workspace_id)) throw fail(409,"Only a stable live deployment can be rolled back.");
    this.restore(row);
    return this.dto(this.get(id));
  }
  async stop(id:string) {
    const row=this.get(id);
    if(this.switching.has(row.workspace_id)) throw fail(409,"Live switch in progress.");
    this.switching.add(row.workspace_id);
    try { return await this.stopInstance(id); }
    finally { this.switching.delete(row.workspace_id); }
  }
  private async stopInstance(id:string) {
    const row=this.get(id);
    const active=this.active.get(id);
    if(active) {
      const text=await this.logs(id).catch(()=>active.log);
      await this.saveLog(row,text);
    }
    this.active.delete(id);
    if(active?.child && active.child.exitCode===null) {
      const child=active.child;
      await new Promise<void>(resolve=>{
        const force=setTimeout(()=>child.kill("SIGKILL"),2000).unref();
        child.once("exit",()=>{clearTimeout(force);resolve();});
        if(!child.kill()){clearTimeout(force);resolve();}
      });
    }
    if(active?.container && await this.containerIdentity(id,active.container)) {
      const config:Config=JSON.parse(row.config_json);
      if(config.mode==="compose") {
        const file=await workspaceFile(this.storageRoot,this.releasePath(config,"compose.json"));
        await command("docker",["compose","-p",active.container,"-f",file,"down"]);
      } else await command("docker",["rm","-f",active.container]);
    }
    if(active) this.pool.release(active.port);
    this.save(id,"stopped");
    return this.dto(this.get(id));
  }
  async close() {
    this.pool.close();
    for(const id of this.active.keys()) await this.stop(id);
  }
}
