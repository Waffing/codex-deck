import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AddressInfo } from "node:net";
import type { ServerContext } from "./app.js";
import { WorkspaceFiles } from "./files/workspace-files.js";
import { ThreadManager, type ManagerOptions } from "./codex/manager.js";
import { Notifications, registerNotifications } from "./notifications/index.js";
import { registerFileRoutes } from "./routes/files.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerOpenApi } from "./routes/open-api.js";
import { registerOps } from "./server-ops/routes.js";
import type { OpsOptions } from "./server-ops/deployer.js";
import { ThreadEvents, registerEventRoutes } from "./ws/events.js";
import { registerConsoleRoutes } from "./routes/console.js";

export type Phase2Options = Omit<ManagerOptions,"port"|"profile"> & Pick<OpsOptions,"portPool"|"proxyConfig"> & {managedWorkspaceDirectory?:string};

export function mountPhase2(app: FastifyInstance, ctx: ServerContext, options: Phase2Options) {
  app.register(websocket, { options: { maxPayload: 65536 } });
  app.register(async service => {
    const events = new ThreadEvents(ctx);
    const notifications = new Notifications(ctx);
    const files = new WorkspaceFiles(ctx,options.dataDirectory,(thread,type,payload) => events.append(thread,type,payload),options.managedWorkspaceDirectory);
    const manager = new ThreadManager(ctx,files,events,notifications,{
      ...options,
      port: () => (app.server.address() as AddressInfo|null)?.port ?? ctx.gatewayConfig.port,
      profile: () => {
        const profile = ops.getProfile();
        return {os:profile.os, runtimes:profile.runtimes, cpu:profile.cpu_count, free_memory:profile.free_memory,
          disk_free:profile.disk_free, safe_pool:profile.safe_pool};
      },
    });
    registerFileRoutes(service,ctx,files);
    registerConsoleRoutes(service,ctx,files);
    registerThreadRoutes(service,ctx,manager);
    registerNotifications(service,ctx,notifications);
    registerOpenApi(service,ctx,files,manager,events);
    const ops = registerOps(service,ctx,files,events,manager,{...options,notifications});
    registerEventRoutes(service,ctx,events,()=>ops.deployer.runningCount());
    service.addHook("onListen",async () => { await manager.recover(); });
    service.addHook("onClose",async () => manager.close());
  });
}
