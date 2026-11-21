import type { ServerContext } from "../app.js";
import { alertEventSchema } from "@codexdeck/shared";
import { readSecurityConfig } from "./config.js";
export function securityEvent(ctx:ServerContext,event:string,actor:string,ip:string|null,detail:Record<string,unknown>={}) {
  const details=ctx.masker.maskObject(detail);
  ctx.native.prepare("INSERT INTO audit_logs(event,actor,ip,details_json,created_at) VALUES(?,?,?,?,?)")
    .run(event,actor,ip,JSON.stringify(details),new Date().toISOString());
  const alert=alertEventSchema.safeParse(event);
  if(alert.success && readSecurityConfig(ctx.native).alerts.includes(alert.data)) {
    void ctx.notifySecurity?.(event,{actor,ip,...details}).catch(()=>{});
  }
}