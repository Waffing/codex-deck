import { execFile } from "node:child_process";
import { createServer, type Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { statfs, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { ServerProfile } from "@codexdeck/shared";
import { workspaceFile } from "../security/paths.js";

const exec = promisify(execFile);
export const fail = (code: number, message: string) => Object.assign(new Error(message), { statusCode: code });

export async function command(bin: string, args: string[], options: { cwd?: string; timeout?: number } = {}) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH","SystemRoot","WINDIR","TEMP","TMP","TMPDIR","HOME","USERPROFILE","LOCALAPPDATA","ProgramData","DOCKER_HOST"]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  const { stdout, stderr } = await exec(bin, args, { env, windowsHide: true, timeout: options.timeout ?? 2500, maxBuffer: 1024 * 1024, cwd: options.cwd });
  return (stdout || stderr).trim();
}

async function portsInUse(): Promise<number[] | null> {
  const windows = process.platform === "win32";
  const sources: [string,string[]][] = windows ? [["netstat",["-an","-p","tcp"]]] : [["ss",["-H","-ltn"]],["netstat",["-an"]]];
  for (const [bin,args] of sources) {
    try {
      const result = await command(bin,args);
      const ports = new Set<number>();
      for (const line of result.split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        const local = bin === "ss" ? cols[3] : windows ? cols[1] : cols[3];
        if (!windows && bin !== "ss" && !line.includes("LISTEN")) continue;
        const match = /[:.](\d+)$/.exec(local ?? "");
        if (match) ports.add(Number(match[1]));
      }
      return [...ports].sort((a,b) => a-b);
    } catch { /* try the platform alternative */ }
  }
  return null;
}

export class PortPool {
  private leases = new Map<number,{workspace:string; socket:Server; timer:NodeJS.Timeout}>();
  private held = new Set<number>();
  constructor(readonly range: [number,number], readonly controlPort: () => number) {
    if (!range.every(n => Number.isInteger(n) && n >= 1 && n <= 65535) || range[0] > range[1]) throw new Error("Invalid staging port pool.");
  }
  safe(port:number) { return Number.isInteger(port) && port >= this.range[0] && port <= this.range[1] && ![22,80,443,this.controlPort()].includes(port); }
  candidates(occupied:number[] = []) {
    const unavailable = new Set([...occupied,...this.held,...this.leases.keys()]);
    return Array.from({length:this.range[1]-this.range[0]+1},(_,i)=>i+this.range[0]).filter(p=>this.safe(p) && !unavailable.has(p));
  }
  async allocate(workspace:string) {
    for (const port of this.candidates()) {
      const socket = createServer(s => s.destroy());
      const bound = await new Promise<boolean>(resolve => {
        socket.once("error",()=>resolve(false));
        socket.listen({port,host:"127.0.0.1",exclusive:true},()=>resolve(true));
      });
      if (!bound) continue;
      const timer = setTimeout(() => { this.leases.delete(port); socket.close(); },60_000).unref();
      this.leases.set(port,{workspace,socket,timer});
      return port;
    }
    throw fail(409,"No staging ports are available.");
  }
  async claim(workspace:string, port:number) {
    const lease = this.leases.get(port);
    if (!lease || lease.workspace !== workspace || !this.safe(port)) throw fail(403,"Port lease does not belong to this workspace.");
    clearTimeout(lease.timer);
    this.leases.delete(port);
    this.held.add(port);
    await new Promise<void>(resolve => lease.socket.close(()=>resolve()));
  }
  release(port:number) { this.held.delete(port); }
  close() {
    for (const lease of this.leases.values()) { clearTimeout(lease.timer); lease.socket.close(); }
    this.leases.clear();
  }
}

export async function probeServer(dataDir:string, workspaceRoot:string, pool:PortPool):Promise<ServerProfile> {
  const versions: Record<string,[string,...string[]]> = {
    python:["python","--version"], go:["go","version"], docker:["docker","--version"], compose:["docker","compose","version"],
    pm2:["pm2","--version"], systemd:["systemctl","--version"], caddy:["caddy","version"], nginx:["nginx","-v"],
  };
  const [installed,occupied,disk] = await Promise.all([
    Promise.all(Object.entries(versions).map(async ([name,[bin,...args]]) => {
      const version = await command(bin,args).catch(()=>null);
      return [name,version ? version.split(/\r?\n/)[0].slice(0,180) : null];
    })), portsInUse(), statfs(dataDir),
  ]);
  const dockerReady=installed.some(([name,value]) => name==="docker" && value)
    ? await command("docker",["info","--format","{{.ServerVersion}}"]).then(Boolean).catch(()=>false) : false;
  const profile: ServerProfile = {
    checked_at:new Date().toISOString(), os:os.type()+" "+os.release()+" "+os.arch(), cpu_count:os.cpus().length,
    load_average:os.loadavg(),total_memory:os.totalmem(),free_memory:os.freemem(),disk_free:disk.bavail*disk.bsize,
    docker_available:dockerReady,runtimes:{node:process.version,...Object.fromEntries(installed)},occupied_ports:occupied ?? [],
    port_inventory_available:occupied !== null,safe_pool:pool.range,available_ports:pool.candidates(occupied ?? []),
  };
  const file = await workspaceFile(workspaceRoot,path.join(dataDir,"server-profile.json"));
  const tmp = await workspaceFile(workspaceRoot,path.join(dataDir,randomUUID()+".json.tmp"));
  await writeFile(tmp,JSON.stringify(profile),{flag:"wx",mode:0o600});
  await rename(tmp,file);
  return profile;
}
