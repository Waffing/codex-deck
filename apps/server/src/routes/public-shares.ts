import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { shareCreateSchema, shareLimitsSchema, shareVerifySchema, type PublicShare, type ShareReaderState } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { fileError, resolveSafeWorkspacePath } from "../files/sandbox.js";
import { sendDocument } from "../files/document-preview.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { hashPassword, verifyPassword, signPayload, verifySignedPayload } from "../security/crypto.js";
import { clientIp, secureTransport } from "../security/ingress.js";

type Row = Omit<PublicShare, "requires_passcode"|"allow_download"> & {
  passcode_hash: string|null; content_sha256:string; size_bytes:number; allow_download:number;
};
type Grant = {session:string;exp:number};
const readTtl = 30*60;
const expired = (row:Row) => row.status==="revoked" || Date.parse(row.expires_at)<=Date.now();
const exhausted = (row:Row) => row.max_views!==null && row.view_count>=row.max_views;
function describe(row:Row):PublicShare {
  const {passcode_hash, content_sha256:_digest, size_bytes:_size, ...result} = row;
  return {...result, requires_passcode:!!passcode_hash, allow_download:!!row.allow_download,
    status:row.status==="revoked"?"revoked":expired(row)?"expired":exhausted(row)?"exhausted":"active"};
}

function readGrant(ctx:ServerContext,req:FastifyRequest,slug:string):Grant|null {
  const token=/(?:^|;\s*)cd_share=([A-Za-z0-9_.-]{1,768})(?:;|$)/.exec(req.headers.cookie??"")?.[1];
  const value=token && verifySignedPayload(token,ctx.masterKey);
  return value && value.aud==="share-read" && value.slug===slug && typeof value.session==="string" &&
    typeof value.exp==="number" && value.exp>Date.now() ? {session:value.session,exp:value.exp} : null;
}

function future(input:string) {
  if(Date.parse(input)<=Date.now()) throw fileError(400,"有效期必须晚于当前时间。");
  return new Date(input).toISOString();
}

export function registerShares(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles) {
  const db=ctx.native;
  const admin={preHandler:createRequireAdmin(ctx)};
  const bySlug=db.prepare("SELECT * FROM public_shares WHERE slug=?");
  const byId=db.prepare("SELECT * FROM public_shares WHERE id=?");
  function managed(id:string) {
    const row=byId.get(id) as Row|undefined;
    if(!row) throw fileError(404,"分享不存在。");
    return row;
  }
  const visited=db.prepare("SELECT 1 FROM public_share_reads WHERE session_id=? AND share_id=? AND expires_at>?");
  const paid=(row:Row,grant:Grant|null)=>!!grant && !!visited.get(grant.session,row.id,Date.now());
  const reserve=db.transaction((slug:string,grant:Grant,download:boolean,charge:boolean)=>{
    const row=bySlug.get(slug) as Row|undefined;
    if(!row || expired(row) || grant.exp<=Date.now()) throw fileError(410,"分享已失效。");
    if(download && !row.allow_download) throw fileError(403,"分享者已关闭原件下载。");
    if(paid(row,grant)) return;
    if(exhausted(row)) throw fileError(410,"分享阅读次数已用完。");
    if(!charge) return;
    db.prepare("DELETE FROM public_share_reads WHERE expires_at<=?").run(Date.now());
    db.prepare("INSERT INTO public_share_reads(session_id,share_id,expires_at) VALUES(?,?,?)").run(grant.session,row.id,grant.exp);
    db.prepare("UPDATE public_shares SET view_count=view_count+1 WHERE id=?").run(row.id);
  });

  app.post("/api/shares",admin,async(req,reply)=>{
    const parsed=shareCreateSchema.safeParse(req.body);
    if(!parsed.success) throw fileError(400,"分享设置无效。");
    const input=parsed.data;
    const a=db.prepare("SELECT workspace_id,path,content_sha256 FROM artifacts WHERE id=?").get(input.artifact_id) as
      {workspace_id:string;path:string;content_sha256:string|null}|undefined;
    if(!a) throw fileError(404,"文件不存在。");
    await resolveSafeWorkspacePath(await files.getRoot(a.workspace_id),a.path);
    const handle=await files.openSnapshot(a.content_sha256??"");
    let size:number;
    try {size=(await handle.stat()).size;} finally {await handle.close();}
    const id=randomUUID(), slug=randomBytes(24).toString("base64url");
    const configured=process.env.CODEXDECK_PUBLIC_ORIGIN || (process.env.CODEXDECK_DOMAIN?"https://"+process.env.CODEXDECK_DOMAIN:"");
    const url=configured?new URL("/s/"+slug,configured).href:"/s/"+slug;
    const hash=input.passcode?await hashPassword(input.passcode):null;
    const expires=future(input.expires_at??new Date(Date.now()+7*86400000).toISOString());
    db.prepare(`INSERT INTO public_shares(id,slug,workspace_id,artifact_id,rel_path,title,share_type,content_sha256,
      size_bytes,passcode_hash,expires_at,max_views,allow_download,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,slug,a.workspace_id,input.artifact_id,a.path,input.title??path.posix.basename(a.path),
      path.posix.extname(a.path).slice(1).toLowerCase() || "file",a.content_sha256,size,hash,expires,
      input.max_views??null,Number(input.allow_download??false),new Date().toISOString());
    return reply.code(201).header("cache-control","no-store").send({...describe(managed(id)),url});
  });
  app.get("/api/shares",admin,async(_req,reply)=>reply.header("cache-control","no-store").send(
    (db.prepare("SELECT * FROM public_shares ORDER BY created_at DESC").all() as Row[]).map(describe)));
  app.patch<{Params:{id:string}}>("/api/shares/:id",admin,async(req)=>{
    const old=managed(req.params.id);
    if(old.status==="revoked") throw fileError(410,"已吊销的分享无法续期。");
    const parsed=shareLimitsSchema.safeParse(req.body);
    if(!parsed.success || !Object.keys(parsed.data).length) throw fileError(400,"分享设置无效。");
    const p=parsed.data;
    db.prepare("UPDATE public_shares SET expires_at=?,max_views=?,allow_download=? WHERE id=?").run(
      p.expires_at?future(p.expires_at):old.expires_at,p.max_views===undefined?old.max_views:p.max_views,
      Number(p.allow_download??old.allow_download),old.id);
    return describe(managed(old.id));
  });
  app.delete<{Params:{id:string}}>("/api/shares/:id",admin,async(req,reply)=>{
    const row=managed(req.params.id);
    db.prepare("UPDATE public_shares SET status='revoked' WHERE id=?").run(row.id);
    return reply.code(204).send();
  });

  const attempts=new Map<string,{until:number;count:number}>();
  let verifying=0;
  const sweep=setInterval(()=>{for(const [ip,item] of attempts) if(item.until<=Date.now()) attempts.delete(ip);},60000);
  sweep.unref(); app.addHook("onClose",async()=>{clearInterval(sweep);});
  app.post<{Params:{slug:string}}>("/api/public/shares/:slug/verify",{bodyLimit:512},async(req,reply)=>{
    reply.header("cache-control","no-store").header("referrer-policy","no-referrer");
    const slug=req.params.slug, parsed=shareVerifySchema.safeParse(req.body??{});
    if(!parsed.success) throw fileError(400,"提取码格式无效。");
    let row=bySlug.get(slug) as Row|undefined;
    const grant=readGrant(ctx,req,slug);
    if(!row || expired(row) || exhausted(row) && !paid(row,grant)) return {state:"unavailable"} satisfies ShareReaderState;
    if(!grant && row.passcode_hash) {
      if(parsed.data.passcode===undefined) return {state:"locked"} satisfies ShareReaderState;
      const ip=clientIp(req);
      let bucket=attempts.get(ip);
      if(bucket && bucket.until<=Date.now()) {attempts.delete(ip);bucket=undefined;}
      if(verifying>=8 || (!bucket && attempts.size>=4096) || (bucket && bucket.count>=5))
        return reply.code(429).header("Retry-After",String(bucket?Math.max(1,Math.ceil((bucket.until-Date.now())/1000)):60)).send({error:"请稍后再试。"});
      bucket??={count:0,until:Date.now()+600000}; bucket.count++; attempts.set(ip,bucket); verifying++;
      try {
        if(!await verifyPassword(parsed.data.passcode,row.passcode_hash)) throw fileError(403,"提取码错误。");
        // A successful check does not clear earlier failed attempts from other tabs or shares.
        bucket.count--;
      } finally {verifying--;}
      row=bySlug.get(slug) as Row|undefined;
      if(!row || expired(row) || exhausted(row)) return {state:"unavailable"} satisfies ShareReaderState;
    }
    if(!grant) {
      const token=signPayload({aud:"share-read",slug,session:randomUUID(),exp:Date.now()+readTtl*1000},ctx.masterKey);
      reply.header("set-cookie","cd_share="+token+"; Path=/api/public/shares/"+slug+"/; HttpOnly; SameSite=Strict; Max-Age="+readTtl+(secureTransport(req)?"; Secure":""));
    }
    return {state:"ready",title:row.title,name:path.posix.basename(row.rel_path),allow_download:!!row.allow_download,
      expires_at:row.expires_at,size:row.size_bytes} satisfies ShareReaderState;
  });
  for(const resource of ["content","download"] as const) {
    app.get<{Params:{slug:string}}>("/api/public/shares/:slug/"+resource,async(req,reply)=>{
      reply.header("cache-control","no-store");
      const slug=req.params.slug, row=bySlug.get(slug) as Row|undefined;
      if(!row || expired(row)) throw fileError(410,"此分享已失效。");
      const grant=readGrant(ctx,req,slug);
      if(!grant) throw fileError(401,"请重新打开分享链接。");
      // Recheck after I/O in the same transaction that consumes the reading slot.
      reserve.immediate(slug,grant,resource==="download",false);
      const handle=await files.openSnapshot(row.content_sha256);
      return sendDocument(ctx,reply,path.posix.basename(row.rel_path),handle,resource==="download",
        ()=>reserve.immediate(slug,grant,resource==="download",req.method!=="HEAD"));
    });
  }
}
