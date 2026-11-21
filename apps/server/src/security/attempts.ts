import { randomInt,randomUUID } from "node:crypto";
import type { ServerContext } from "../app.js";
import type { SecurityConfig } from "@codexdeck/shared";
import { securityEvent } from "./activity.js";

export function banSeconds(ctx:ServerContext,ip:string,config:SecurityConfig) {
  if (!config.brute_force_enabled) return 0;
  const until=ctx.native.prepare("SELECT banned_until FROM login_bans WHERE ip=?").pluck().get(ip) as number|undefined;
  return Math.max(0,Math.ceil(((until??0)-Date.now())/1000));
}
export function failedAttempt(ctx:ServerContext,ip:string,config:SecurityConfig) {
  if (!config.brute_force_enabled) return;
  const now=Date.now();
  ctx.native.transaction(()=>{
    const old=ctx.native.prepare("SELECT failures,banned_until FROM login_bans WHERE ip=?").get(ip) as {failures:number;banned_until:number}|undefined;
    if(old && old.banned_until>now) return;
    const failures=(old && old.banned_until===0?old.failures:0)+1;
    const until=failures>=config.max_failures?now+config.ban_minutes*60_000:0;
    ctx.native.prepare("INSERT INTO login_bans VALUES(?,?,?,?) ON CONFLICT(ip) DO UPDATE SET failures=excluded.failures,banned_until=excluded.banned_until,last_attempt=excluded.last_attempt")
      .run(ip,failures,until,now);
    if(until) securityEvent(ctx,"login_ban","anonymous",ip,{until:new Date(until).toISOString()});
  }).immediate();
}
const segments=["2,2 15,2","16,3 16,14","16,16 16,27","2,28 15,28","1,16 1,27","1,3 1,14","2,15 15,15"];
const digits=["abcdef","bc","abdeg","abcdg","bcfg","acdfg","acdefg","abc","abcdefg","abcdfg"];

export class Captchas {
  private readonly challenges=new Map<string,{ip:string;answer:string;expires:number}>();
  issue(ip:string) {
    const now=Date.now();
    for(const [key,item] of this.challenges) if(item.expires<=now) this.challenges.delete(key);
    if(this.challenges.size>=1024) this.challenges.delete(this.challenges.keys().next().value!);
    const id=randomUUID(),answer=Array.from({length:5},()=>String(randomInt(10))).join("");
    this.challenges.set(id,{ip,answer,expires:now+120_000});
    const glyphs=Array.from(answer,(n,i)=>{
      const lines=Array.from(digits[Number(n)],c=>'<polyline points="'+segments[c.charCodeAt(0)-97]+'"/>').join("");
      return '<g transform="translate('+(8+i*24)+' '+randomInt(4,8)+') rotate('+randomInt(-9,10)+' 8 15)">'+lines+'</g>';
    }).join("");
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="140" height="44" viewBox="0 0 140 44"><rect width="140" height="44" fill="#fff"/><g fill="none" stroke="#24304a" stroke-width="3" stroke-linecap="round">'+glyphs+'</g></svg>';
    return {id,svg};
  }
  check(ip:string,id:string|undefined,answer:string|undefined) {
    if(!id) return false;
    const value=this.challenges.get(id);
    if(!value || value.ip!==ip) return false;
    this.challenges.delete(id);
    return value.expires>Date.now() && value.answer===answer;
  }
}