import { pathToFileURL } from "node:url";
import { openDatabase, resolveDataDirectory } from "../db/index.js";
import { loadMasterKey } from "../security/crypto.js";
import { generateCodexConfig } from "./config-gen.js";

/** Run against the server using its own data directory, port and short-lived internal token. */
export async function smoke(config: Awaited<ReturnType<typeof generateCodexConfig>>): Promise<void> {
  const response = await fetch(config.baseUrl + "/responses", {
    method: "POST",
    headers: { authorization: "Bearer " + config.env.CODEXDECK_INTERNAL_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ model: config.alias, input: "Reply with OK.", stream: false }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Gateway smoke request returned HTTP ${response.status}.`);
  const result = await response.json() as { object?: string; status?: string; output?: unknown };
  if (result.object !== "response" || result.status !== "completed" || !Array.isArray(result.output)) {
    throw new Error("Gateway smoke request did not return a completed Responses object.");
  }
}

async function main(): Promise<void> {
  const dataDirectory = await resolveDataDirectory();
  const database = await openDatabase(dataDirectory);
  try {
    const config = await generateCodexConfig({
      native: database.native, dataDirectory, masterKey: await loadMasterKey(dataDirectory),
      port: Number(process.argv[2] ?? process.env.CODEXDECK_PORT ?? 3210),
    });
    await smoke(config);
    console.info("CodexDeck gateway smoke request completed.");
  } finally {
    database.native.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => {
    console.error("CodexDeck smoke failed. Check the running server, selected model, port and data directory.");
    process.exitCode = 1;
  });
}
