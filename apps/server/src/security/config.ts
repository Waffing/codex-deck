import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { securityPatchSchema,securityConfigSchema,type SecurityConfig } from "@codexdeck/shared";
import { hashPassword } from "./crypto.js";
import { inRange,validRange } from "./ingress.js";
import { EventEmitter } from "node:events";

const policyChanges=new WeakMap<Database.Database,EventEmitter>();
export function onAccessPolicyChange(db:Database.Database,callback:()=>void) {
  const events=policyChanges.get(db)??new EventEmitter();
  policyChanges.set(db,events);
  events.on("changed",callback);
  return ()=>events.off("changed",callback);
}

export function getSetting(db:Database.Database,key:string):string|undefined {
  return db.prepare("SELECT value FROM settings WHERE key=?").pluck().get(key) as string|undefined;
}
export function setSetting(db:Database.Database,key:string,value:string) {
  db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
    .run(key,value,new Date().toISOString());
}
function defaults(bootstrap:boolean):SecurityConfig {
  const exposed=bootstrap && process.env.CODEXDECK_PUBLIC_ENABLED==="true";
  const entry=bootstrap && process.env.CODEXDECK_ENTRY_PATH;
  return securityConfigSchema.parse({public_enabled:exposed,entry_enabled:exposed,entry_path:entry || "/"+randomBytes(6).toString("base64url"),
    disguise:"nginx_404",brute_force_enabled:true,max_failures:5,ban_minutes:15,captcha_enabled:false,ip_mode:"off",ip_ranges:[],
    session_hours:24,single_session:false,basic_enabled:false,basic_user:"admin",totp_enabled:false,alerts:[]});
}
export function readSecurityConfig(db:Database.Database):SecurityConfig {
  let raw=getSetting(db,"security.config");
  if (!raw) {
    db.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('security.config',?,?)").run(JSON.stringify(defaults(true)),new Date().toISOString());
    raw=getSetting(db,"security.config")!;
  }
  return {...securityConfigSchema.parse(JSON.parse(raw)),totp_enabled:!!getSetting(db,"security.totp")};
}
export function ipAllowed(config:SecurityConfig,ip:string) {
  if (config.ip_mode==="off") return true;
  const listed=config.ip_ranges.some(range=>inRange(ip,range));
  return config.ip_mode==="allow"?listed:!listed;
}
export function invalid(message:string) {return Object.assign(new Error(message),{statusCode:400});}

export async function updateSecurityConfig(db:Database.Database,input:unknown,currentIp?:string) {
  const parsed=securityPatchSchema.safeParse(input);
  if(!parsed.success) throw invalid("Invalid security settings.");
  const {basic_password,...patch}=parsed.data;
  if(patch.ip_ranges?.some(rule=>!validRange(rule))) throw invalid("Invalid IP address or CIDR.");
  const digest=basic_password && await hashPassword(basic_password);
  const config=db.transaction(()=>{
    const previous=readSecurityConfig(db);
    const next={...previous,...patch};
    if(patch.public_enabled && !previous.public_enabled && patch.entry_enabled===undefined) next.entry_enabled=true;
    if (currentIp && !ipAllowed(next,currentIp)) throw invalid("Current administrator IP would be excluded.");
    if (next.basic_enabled && !digest && !getSetting(db,"security.basic_hash")) throw invalid("Supply a Basic authentication password.");
    if(digest) setSetting(db,"security.basic_hash",digest);
    setSetting(db,"security.config",JSON.stringify(next));
    return next;
  }).immediate();
  if(["public_enabled","ip_mode","ip_ranges","basic_enabled","basic_user","basic_password","entry_enabled","entry_path"].some(key=>Object.hasOwn(parsed.data,key))) {
    policyChanges.get(db)?.emit("changed");
  }
  return config;
}
export function resetSecurityConfig(db:Database.Database) {
  const result=db.transaction(()=>{
    const config=defaults(false);
    db.prepare("DELETE FROM settings WHERE key IN ('security.basic_hash','security.totp','security.totp_pending','security.recovery','security.totp_step')").run();
    db.prepare("DELETE FROM login_bans").run();
    setSetting(db,"security.config",JSON.stringify(config));
    return config;
  }).immediate();
  policyChanges.get(db)?.emit("changed");
  return result;
}
