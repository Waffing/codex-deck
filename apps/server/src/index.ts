import { createServer, parseGatewayConfig } from "./app.js";
import { pathToFileURL } from "node:url";
import { openDatabase, resolveDataDirectory } from "./db/index.js";
import { loadMasterKey } from "./security/crypto.js";
import { SecretMasker } from "./security/secret-masker.js";
import { repositoryRoot, workspaceFile } from "./security/paths.js";
import path from "node:path";
import { writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { installationCode } from "./routes/auth.js";
import { listenPublicTls } from "./security/public-listener.js";

export async function startServer(): Promise<void> {
  const workspaceRoot = process.env.CODEXDECK_WORKSPACES ?? repositoryRoot;
  const dataDirectory = await resolveDataDirectory(undefined, workspaceRoot);
  const masterKey = await loadMasterKey(dataDirectory, undefined, workspaceRoot);
  const database = await openDatabase(dataDirectory, workspaceRoot);
  const setupFile = await workspaceFile(dataDirectory,path.join(dataDirectory,"setup-code"));
  if (!database.native.prepare("SELECT 1 FROM settings WHERE key='admin_password_hash'").get()) {
    const temp = await workspaceFile(dataDirectory,path.join(dataDirectory,randomUUID()+".tmp"));
    await writeFile(temp,installationCode(database.native,masterKey)+"\n",{mode:0o600,flag:"wx"});
    await rename(temp,setupFile);
    console.info("First administrator setup requires the private setup-code file in the data directory.");
  } else await rm(setupFile,{force:true});
  const config = parseGatewayConfig();
  const server = createServer({
    ...database,
    masterKey,
    masker: new SecretMasker(),
    gatewayConfig: config,
  }, { dataDirectory, workspaceRoot, managedWorkspaceDirectory: process.env.CODEXDECK_WORKSPACES, ...runtimeOptions() });
  const address = await server.listen({ host: config.host, port: config.port });
  let tls;
  try { tls=await listenPublicTls(server,dataDirectory,config.port); }
  catch (e) { await server.close(); database.native.close(); throw e; }
  console.info(`CodexDeck server listening at ${address}`);
  const close = async () => {
    tls?.close();
    await server.close();
    database.native.close();
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}

function runtimeOptions() {
  const range = process.env.CODEXDECK_PORT_POOL;
  const match = range && /^(\d+)-(\d+)$/.exec(range);
  if (range && !match) throw new Error("Invalid port pool.");
  const configuredTimeout = process.env.CODEXDECK_APPROVAL_TIMEOUT_MS;
  const approvalTimeoutMs = configuredTimeout === undefined ? undefined : Number(configuredTimeout);
  if (approvalTimeoutMs !== undefined && (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs <= 0)) throw new Error("Invalid approval timeout.");
  const type = process.env.CODEXDECK_PROXY_TYPE;
  const proxyPath = process.env.CODEXDECK_PROXY_CONFIG;
  let proxyConfig: {type:"caddy"|"nginx";path:string} | undefined;
  if (type || proxyPath) {
    if (!proxyPath || (type !== "caddy" && type !== "nginx")) throw new Error("Invalid managed proxy configuration.");
    proxyConfig = {type,path:proxyPath};
  }
  return { approvalTimeoutMs, proxyConfig, portPool: match ? [Number(match[1]),Number(match[2])] as [number,number] : undefined };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(() => {
    console.error("CodexDeck startup failed. Check the data directory, master key and listening port.");
    process.exitCode = 1;
  });
}
