import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openDatabase } from "./db/index.js";
import { parseGatewayConfig } from "./app.js";
import { loadMasterKey, rotationProof } from "./security/crypto.js";
import { emergency, signAdminRequest } from "./security/emergency.js";
import { SecretMasker } from "./security/secret-masker.js";
import { workspaceFile } from "./security/paths.js";

async function inputText() {
  if (process.stdin.isTTY) throw new Error("Provide this command's input on stdin.");
  let input="";
  for await (const chunk of process.stdin) {
    input+=chunk;
    if (Buffer.byteLength(input)>65536) throw new Error("Input exceeds 64 KiB.");
  }
  return input.replace(/\r?\n$/,"");
}

export async function runAdmin(args:string[]) {
  const offline=args[0]==="--offline";
  if (offline) args=args.slice(1);
  const [requested,id]=args;
  const requireExecutor=requested==="require-executor";
  const action=requireExecutor?"executor":requested;
  if (!action || action==="--help") {
    console.log("codex-deck admin [--offline] security|security-set|security-reset|preferences|preferences-set|preferences-reset|defaults-reset|executor|require-executor|channels|channel-create|channel-update ID|channel-delete ID|reset-password|unban [IP]|two-factor-off|temp-create URL|temp-list|temp-revoke ID|temp-extend ID|tasks|kill THREAD. Supply passwords or JSON on stdin.");
    return;
  }
  if (args.length>2) throw new Error("Unexpected argument.");
  if (requireExecutor && offline) throw new Error("Executor readiness requires a running server.");
  const data=await realpath(process.env.CODEXDECK_DATA_DIR || ".codexdeck");
  await access(await workspaceFile(data,path.join(data,"codexdeck.sqlite")));
  if (!process.env.CODEXDECK_MASTER_KEY) await access(await workspaceFile(data,path.join(data,"master.key")));
  const masterKey=await loadMasterKey(data);
  const runtime=action==="tasks" || action==="kill";
  let route="/api/admin/security/emergency", method="POST";
  let body:Record<string,unknown>|undefined;
  if (runtime) {
    if (offline) throw new Error("Runtime tasks require a running server.");
    if (action==="tasks") {method="GET";route="/api/admin/runtime/tasks";}
    else {
      if (!id || !/^[\w-]{1,128}$/.test(id)) throw new Error("Invalid thread ID.");
      route="/api/admin/runtime/tasks/"+encodeURIComponent(id)+"/kill";
    }
  } else {
    body={action};
    if (id) body[action==="temp-create"?"origin":"id"]=id;
    if (action==="reset-password" || action==="totp-confirm") body.input=await inputText();
    if (["security-set","preferences-set","executor-set","channel-create","channel-update","temp-create","temp-extend"].includes(action)) {
      try {body.input=JSON.parse(await inputText());} catch {throw new Error("Supply valid JSON on stdin.");}
    }
  }
  const gatewayConfig=parseGatewayConfig();
  let result:unknown;
  if (offline) {
    const database=await openDatabase(data);
    try {
      const proof=database.native.prepare("SELECT value FROM settings WHERE key='crypto.key-check'").pluck().get();
      if (proof!=null && proof!==rotationProof(masterKey)) throw new Error("Incorrect master key.");
      result=await emergency({...database,gatewayConfig,masterKey,masker:new SecretMasker()},body);
    } finally {database.native.close();}
  } else {
    const headers:Record<string,string>={"x-codexdeck-admin":signAdminRequest(masterKey,method,route,body)};
    if (body) headers["content-type"]="application/json";
    const response=await fetch("http://127.0.0.1:"+gatewayConfig.port+route,{
      method,headers,body:body?JSON.stringify(body):undefined,redirect:"error",signal:AbortSignal.timeout(action==="executor"?60000:15000),
    });
    if (!response.ok) throw new Error("Management request returned HTTP "+response.status+".");
    result=await response.json();
  }
  console.log(JSON.stringify(result,null,2));
  if (requireExecutor && (!result || typeof result!=="object" || !("available" in result) || result.available!==true)) {
    throw new Error("Full access executor readiness check failed.");
  }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  runAdmin(process.argv.slice(2)).catch(e=>{
    console.error(e instanceof Error?e.message:"Management operation failed.");process.exitCode=1;
  });
}
