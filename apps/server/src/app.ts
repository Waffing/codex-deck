import Fastify from "fastify";
import compress from "@fastify/compress";
import type Database from "better-sqlite3";
import { gatewayConfigSchema, type GatewayConfig } from "@codexdeck/shared";
import type { CodexDeckDatabase } from "./db/index.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerGatewayRoutes } from "./gateway/server.js";
import { rotationProof } from "./security/crypto.js";
import { SecretMasker } from "./security/secret-masker.js";
import { registerStoredCredentials } from "./gateway/credentials.js";
import { mountPhase2, type Phase2Options } from "./phase2.js";
import { mountWeb } from "./web-static.js";
import { repositoryRoot } from "./security/paths.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerAdminAudit } from "./routes/admin-audit.js";
import { registerPublicGate } from "./security/public-gate.js";
import { registerSecurityRoutes } from "./security/routes.js";
import { registerTempAccess } from "./temp-access/routes.js";

export interface ServerContext {
  native: Database.Database;
  orm: CodexDeckDatabase;
  masterKey: Buffer;
  masker: SecretMasker;
  gatewayConfig: GatewayConfig;
  onUsageRecorded?: () => void;
  notifySecurity?: (event:string,payload:unknown)=>Promise<void>;
  resolveSessionLease?: (credential:string, kind:"model"|"ops")=>string|null;
}

export function createServer(context: ServerContext, options?: Phase2Options & {webRoot?:string}) {
  const expectedKey = context.native.prepare("SELECT value FROM settings WHERE key='crypto.key-check'").pluck().get();
  if (expectedKey != null && expectedKey !== rotationProof(context.masterKey)) throw new Error("The configured master key does not match the rotated database.");
  const app = Fastify({ logger: false, genReqId:()=>randomUUID(),bodyLimit: 2 * 1024 * 1024, trustProxy: false });
  app.register(compress, {global:false, globalDecompression:false, encodings:["br","gzip"]});
  app.addHook("onRoute", route => {
    if (route.method==="GET" && route.url.startsWith("/api/") &&
      !/^\/api\/(?:v1\/|dl\/|auth\/|security\/|temp-access|settings\/backup)/.test(route.url)) {
      route.compress = {threshold:1024,encodings:["br","gzip"]};
    }
  });
  registerPublicGate(app,context);
  registerTempAccess(app,context);
  registerSecurityRoutes(app,context);
  app.addHook("onRequest",async(req,reply)=>{reply.header("X-Request-Id",req.id);});
  registerAdminAudit(app,context);
  const systemPorts = new Set([22, 80, 443]);
  if (systemPorts.has(context.gatewayConfig.port)) throw new Error("CodexDeck cannot listen on a protected system port.");

  const health = async () => ({ status: "ok", version: process.env.CODEXDECK_VERSION ?? "1.3.0", uptime: Math.floor(process.uptime()) });
  app.get("/health", health);
  app.get("/api/health", health);
  registerStoredCredentials(context);
  app.addHook("preSerialization", async (request, _reply, payload) =>
    request.url.startsWith("/api/") ? context.masker.maskObject(payload) : payload);
  registerAuthRoutes(app, context);
  // Install model routes after @fastify/compress has registered its onRoute hook.
  app.register(async providers => registerProviderRoutes(providers,context));
  registerGatewayRoutes(app, context);
  if (options) mountPhase2(app, context, options);
  if (options?.webRoot) mountWeb(app,options.webRoot,options.workspaceRoot);
  else if (process.env.NODE_ENV === "production") mountWeb(app,path.join(repositoryRoot,"apps/web/dist"));
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    const code = status && status >= 400 && status < 500 ? status : 500;
    const publicMessage=error instanceof Error && code<500 && !("code" in error) ? context.masker.maskString(error.message) : code<500 ? "Invalid request." : "Internal server error.";
    if (code>=500) console.error(JSON.stringify({request_id:request.id,route:request.routeOptions.url,status:code}));
    if (!reply.sent) void reply.code(code).send({ error:publicMessage, request_id:request.id });
  });
  return app;
}

export function parseGatewayConfig(input: Partial<GatewayConfig> = {}): GatewayConfig {
  const port = input.port ?? Number(process.env.CODEXDECK_PORT ?? 3210);
  const config = gatewayConfigSchema.parse({ host: process.env.CODEXDECK_HOST, ...input, port });
  if ([22, 80, 443].includes(config.port)) throw new Error("CodexDeck cannot listen on a protected system port.");
  return config;
}
