// Executed only inside the dedicated project container.
import {createConnection,createServer} from "node:net";
import {spawn} from "node:child_process";
import {appendFile,copyFile, mkdir} from "node:fs/promises";
import {once} from "node:events";

const home="/codex";
await mkdir(home,{recursive:true});
for(const file of ["config.toml","AGENTS.md"]) await copyFile("/run/deck-config/"+file,home+"/"+file);
if(process.env.HTTPS_PROXY==="http://127.0.0.1:3141") {
  await appendFile(home+"/config.toml",`\n[shell_environment_policy.set]\nHTTPS_PROXY = "http://127.0.0.1:3141"\nhttps_proxy = "http://127.0.0.1:3141"\nNO_PROXY = "localhost,127.0.0.1"\n`);
}
const relay=createServer(client=>{
  const socket=createConnection("/run/deck.sock");
  socket.on("error",()=>client.destroy());
  client.on("error",()=>socket.destroy());
  socket.once("close",()=>client.destroy());
  client.once("close",()=>socket.destroy());
  client.pipe(socket).pipe(client);
});
relay.listen(3141,"127.0.0.1");
await once(relay,"listening");
const child=spawn("codex",["app-server"],{stdio:"inherit"});
child.once("error",()=>process.exit(1));
child.once("exit",code=>process.exit(code??1));
