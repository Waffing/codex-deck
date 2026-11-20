import { spawn } from "node:child_process";

// Keep the user process attached to the control plane lifetime even after a crash.
const [executable,...args]=process.argv.slice(2);
const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:["ignore","inherit","inherit"]});
child.once("spawn",()=>process.send?.(child.pid));
child.once("exit",code=>process.exit(code ?? 1));
child.once("error",()=>process.exit(1));
const stop=()=>child.kill("SIGKILL");
process.once("disconnect",stop);
process.once("SIGTERM",stop);
