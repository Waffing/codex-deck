import { createServer, parseGatewayConfig } from "./app.js";
import { pathToFileURL } from "node:url";
import { openDatabase, resolveDataDirectory } from "./db/index.js";
import { loadMasterKey } from "./security/crypto.js";
import { SecretMasker } from "./security/secret-masker.js";
import { repositoryRoot } from "./security/paths.js";

export async function startServer(): Promise<void> {
  const workspaceRoot = process.env.CODEXDECK_WORKSPACES ?? repositoryRoot;
  const dataDirectory = await resolveDataDirectory(undefined, workspaceRoot);
  const masterKey = await loadMasterKey(dataDirectory, undefined, workspaceRoot);
  const database = await openDatabase(dataDirectory, workspaceRoot);
  const config = parseGatewayConfig();
  const server = createServer({
    ...database,
    masterKey,
    masker: new SecretMasker(),
    gatewayConfig: config,
  }, { dataDirectory, workspaceRoot, managedWorkspaceDirectory: process.env.CODEXDECK_WORKSPACES, ...runtimeOptions() });
  const address = await server.listen({ host: config.host, port: config.port });
  console.info(`CodexDeck server listening at ${address}`);
  const close = async () => {
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
  const approvalTimeoutMs = Number(process.env.CODEXDECK_APPROVAL_TIMEOUT_MS ?? 600000);
  if (!Number.isSafeInteger(approvalTimeoutMs) || approvalTimeoutMs <= 0) throw new Error("Invalid approval timeout.");
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
