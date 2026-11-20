import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test.each(["graceful","crash"])("recovers live and preceding releases after a %s controller restart",async shutdown=>{
  const dir=await mkdtemp(path.join(tmpdir(),"codexdeck-recovery-"));
  let child:ChildProcess|undefined;
  async function start(mode:string) {
    child=fork(fileURLToPath(new URL("./fixtures/deployment-recovery.ts",import.meta.url)),[dir,mode],{
      env:{...process.env,DOCKER_HOST:"",CODEXDECK_DEPLOYMENT_NETWORK:""},execArgv:["--import",import.meta.resolve("tsx")],
      stdio:["ignore","ignore","pipe","ipc"]});
    const proc=child;
    return new Promise<{url:string;id:string}>((resolve,reject)=>{
      let stderr="";
      proc.stderr?.on("data",chunk=>{stderr=(stderr+chunk).slice(-2048);});
      proc.once("error",reject); proc.once("exit",()=>reject(new Error("Recovery fixture exited: "+stderr)));
      proc.once("message",value=>resolve(value as {url:string;id:string}));
    });
  }
  async function stop(crash:boolean) {
    if(!child || child.exitCode!==null || child.signalCode!==null) return;
    const exited=once(child,"exit");
    if(crash) child.kill("SIGKILL"); else child.send("close");
    await exited;
  }
  try {
    const seed=await start("seed");
    expect(await (await fetch(seed.url)).text()).toBe("current");
    await stop(shutdown==="crash");
    const restored=await start("recover");
    expect(restored.id).toBe(seed.id);
    expect(await (await fetch(restored.url)).text()).toBe("current");
    const ack=once(child!,"message");child!.send("rollback");await ack;
    expect(await (await fetch(restored.url)).text()).toBe("old");
  } finally {
    await stop(false);
    await rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:200});
  }
},45000);
