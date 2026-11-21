// Runs inside the verification sandbox. The project is copied once so sequential commands share build outputs.
import {spawn} from "node:child_process";
import {once} from "node:events";
import {mkdir} from "node:fs/promises";

async function main() {
  let request="";
  for await(const chunk of process.stdin) request+=chunk;
  const {commands,env}=JSON.parse(request) as {commands:string[];env:Record<string,string>};
  // This deadline also terminates the container's process tree if its controlling server exits.
  const deadline=setTimeout(()=>process.exit(124),120_000);
  await mkdir("/tmp/workspace");
  const copy=spawn("/bin/cp",["-a","--no-preserve=ownership","/source/.","/tmp/workspace"],{stdio:["ignore","ignore","ignore"]});
  if((await once(copy,"close"))[0]!==0) throw new Error("Could not prepare verification workspace.");
  const send=(frame:unknown)=>process.stdout.write(JSON.stringify(frame)+"\n");
  for(const [index,command] of commands.entries()) {
    deadline.refresh();
    send({index,kind:"start"});
    const child=spawn("/bin/sh",["-c",command],{cwd:"/tmp/workspace",stdio:["ignore","pipe","pipe"],
      env:{PATH:"/usr/local/bin:/usr/bin:/bin",HOME:"/tmp",CI:"true",...env}});
    for(const stream of ["stdout","stderr"] as const)
      child[stream].setEncoding("utf8").on("data",(text:string)=>send({index,kind:"output",stream,text}));
    const [code]=await once(child,"close");
    send({index,kind:"end",code});
    if(code!==0) break;
  }
  clearTimeout(deadline);
}
await main().catch(()=>{process.stderr.write("Verification sandbox could not start the command.\n");process.exit(1);});
