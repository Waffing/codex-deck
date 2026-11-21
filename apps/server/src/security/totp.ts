import { createHash,createHmac,randomBytes,timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import type { ServerContext } from "../app.js";
import { getSetting,setSetting,invalid } from "./config.js";
import { decryptSecret,encryptSecret } from "./crypto.js";

const alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes:Buffer) {
  let result="",bits=0,buffer=0;
  for(const byte of bytes) {
    buffer=buffer<<8|byte;
    bits+=8;
    while(bits>=5) {bits-=5;result+=alphabet[(buffer>>>bits)&31];}
  }
  if(bits) result+=alphabet[(buffer<<(5-bits))&31];
  return result;
}
export function totp(key:Buffer,step:number):string {
  const message=Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(step));
  const mac=createHmac("sha1",key).update(message).digest();
  const offset=mac[mac.length-1]&15;
  return String((mac.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,"0");
}
function validStep(bytes:Buffer,otp:string,last:number):number|null {
  if(!/^\d{6}$/.test(otp)) return null;
  const now=Math.floor(Date.now()/30_000);
  for(const step of [now,now-1,now+1]) {
    if(step>last && timingSafeEqual(Buffer.from(totp(bytes,step)),Buffer.from(otp))) return step;
  }
  return null;
}
export function enrollTotp(ctx:ServerContext,session:string) {
  if(getSetting(ctx.native,"security.totp")) throw invalid("Two-factor authentication is active.");
  const key=randomBytes(20),manual_key=base32(key);
  const payload={key:key.toString("base64"),expires:Date.now()+600_000,session};
  setSetting(ctx.native,"security.totp_pending",encryptSecret(JSON.stringify(payload),ctx.masterKey));
  return {manual_key,otpauth_uri:"otpauth://totp/CodexDeck:admin?issuer=CodexDeck&algorithm=SHA1&digits=6&period=30&secret="+manual_key};
}
const codeHash=(input:string)=>createHash("sha256").update(input.trim().toLowerCase()).digest("hex");

export function activateTotp(ctx:ServerContext,session:string,otp:string) {
  return ctx.native.transaction(()=>{
    const raw=getSetting(ctx.native,"security.totp_pending");
    if(!raw || getSetting(ctx.native,"security.totp")) throw invalid("Start a new enrollment.");
    const record=JSON.parse(decryptSecret(raw,ctx.masterKey)) as {key:string;expires:number;session:string};
    const step=validStep(Buffer.from(record.key,"base64"),otp,-1);
    if(record.session!==session || record.expires<=Date.now() || step===null) throw invalid("Invalid enrollment code.");
    const codes=Array.from({length:8},()=>randomBytes(10).toString("hex").match(/.{5}/g)!.join("-"));
    setSetting(ctx.native,"security.totp",encryptSecret(record.key,ctx.masterKey));
    setSetting(ctx.native,"security.totp_step",String(step));
    setSetting(ctx.native,"security.recovery",encryptSecret(JSON.stringify(codes.map(codeHash)),ctx.masterKey));
    ctx.native.prepare("DELETE FROM settings WHERE key='security.totp_pending'").run();
    return codes;
  }).immediate();
}
export function consumeOtp(ctx:ServerContext,input:string):boolean {
  if(input.length>64) return false;
  return ctx.native.transaction(()=>{
    const active=getSetting(ctx.native,"security.totp");
    if(!active) return false;
    const step=validStep(Buffer.from(decryptSecret(active,ctx.masterKey),"base64"),input,Number(getSetting(ctx.native,"security.totp_step")??-1));
    if(step!==null) {setSetting(ctx.native,"security.totp_step",String(step));return true;}
    const stored=getSetting(ctx.native,"security.recovery");
    if(!stored) return false;
    const codes=JSON.parse(decryptSecret(stored,ctx.masterKey)) as string[];
    const index=codes.indexOf(codeHash(input));
    if(index===-1) return false;
    codes.splice(index,1);
    setSetting(ctx.native,"security.recovery",encryptSecret(JSON.stringify(codes),ctx.masterKey));
    return true;
  }).immediate();
}
export function disableTotp(db:Database.Database) {
  db.prepare("DELETE FROM settings WHERE key IN ('security.totp','security.totp_pending','security.recovery','security.totp_step')").run();
}