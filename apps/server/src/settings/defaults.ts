import {workbenchPreferencesSchema} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {revokeSessions} from "../auth.js";
import {readSecurityConfig,resetSecurityConfig} from "../security/config.js";
import {securityEvent} from "../security/activity.js";
import {patchPreferences} from "./preferences.js";

export function resetPanelDefaults(ctx:ServerContext, actor="host", ip:string|null=null) {
  return ctx.native.transaction(()=>{
    if(readSecurityConfig(ctx.native).totp_enabled) securityEvent(ctx,"totp_changed",actor,ip,{enabled:false});
    patchPreferences(ctx.native,workbenchPreferencesSchema.parse({}));
    resetSecurityConfig(ctx.native);
    revokeSessions(ctx.native);
    securityEvent(ctx,"settings.reset",actor,ip);
    return {reset:true};
  }).immediate();
}
