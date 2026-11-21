import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {readdir,unlink} from "node:fs/promises";
import type {FastifyInstance} from "fastify";
import {moduleSwitchSchema,mcpInputSchema,pluginIdSchema,promptTemplateSchema,sessionArchiveSchema,skillFileSchema,type McpEntry,type PromptTemplate} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import type {ThreadManager} from "../codex/manager.js";
import type {WorkspaceFiles} from "../files/workspace-files.js";
import {createRequireAdmin} from "../auth.js";
import {fileError,missing,resolveSafeWorkspacePath} from "../files/sandbox.js";
import {readEditable,writeEditable} from "../files/editor.js";
import {pluginEnabled,mcpEntries} from "../settings/modules.js";
import {publicMcpProbe} from "../gateway/transport.js";
import {z} from "zod";

type ById={Params:{id:string}};
const initMessage=JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"CodexDeck",version:"1"}}});
function validHandshake(value:string) {
  try{const msg=JSON.parse(value);return msg.id===1 && typeof msg.result?.serverInfo?.name==="string" && typeof msg.result.protocolVersion==="string";}
  catch{return false;}
}
async function probeMcp(entry:McpEntry,opsEntry:string,port:number) {
  if(entry.builtin){
    return new Promise<boolean>(resolve=>{
      const child=execFile(process.execPath,[opsEntry],{env:{CODEXDECK_OPS_URL:"http://127.0.0.1:"+port+"/internal/ops",CODEXDECK_OPS_TOKEN:"initialize-only"},
        timeout:4000,maxBuffer:65536,windowsHide:true},(_err,out)=>resolve(String(out).split(/\r?\n/).some(validHandshake)));
      child.stdin?.on("error",()=>{});
      child.stdin?.end(initMessage+"\n");
    });
  }
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),4500);
  try{
    const response=await publicMcpProbe(new URL(entry.url!),initMessage,stop.signal);
    if(!response.ok || !response.body)return false;
    let received=0,body="";
    const decoder=new TextDecoder();
    for await(const chunk of response.body){
      received+=chunk.length;if(received>65536)return false;
      body+=decoder.decode(chunk,{stream:true});
      if(validHandshake(body) || body.split(/\r?\n/).some(line=>line.startsWith("data:") && validHandshake(line.slice(5))))return true;
    }
    return false;
  }catch{return false;}finally{clearTimeout(timer);stop.abort();}
}

export function registerModuleRoutes(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles,manager:ThreadManager,opsEntry:string) {
  const admin={preHandler:createRequireAdmin(ctx)},db=ctx.native;
  function safe<T>(value:T) {
    const serialized=JSON.stringify(value);
    if(ctx.masker.maskString(serialized)!==serialized)throw fileError(400,"请移除凭证后保存。");
    return value;
  }
  function checkChanges(changes:number){if(!changes)throw fileError(404,"记录不存在。");}
  const prompt=(id:string)=>db.prepare("SELECT * FROM prompt_templates WHERE id=?").get(id) as PromptTemplate|undefined;
  app.get("/api/prompts",admin,async()=>db.prepare("SELECT * FROM prompt_templates ORDER BY name,id").all());
  app.post("/api/prompts",admin,async(req,reply)=>{
    const value=safe(promptTemplateSchema.parse(req.body)),id=randomUUID();
    db.prepare("INSERT INTO prompt_templates VALUES(?,?,?)").run(id,value.name,value.content);
    return reply.code(201).send(prompt(id));
  });
  app.patch<ById>("/api/prompts/:id",admin,async req=>{
    const old=prompt(req.params.id);if(!old)throw fileError(404,"模板不存在。");
    const value=safe(promptTemplateSchema.partial().parse(req.body));
    db.prepare("UPDATE prompt_templates SET name=?,content=? WHERE id=?").run(value.name??old.name,value.content??old.content,old.id);
    return prompt(old.id);
  });
  app.delete<ById>("/api/prompts/:id",admin,async(req,reply)=>{
    checkChanges(db.prepare("DELETE FROM prompt_templates WHERE id=?").run(req.params.id).changes);return reply.code(204).send();
  });
  app.get("/api/plugins",admin,async()=>pluginIdSchema.options.map(id=>({id,enabled:pluginEnabled(db,id)})));
  app.patch<ById>("/api/plugins/:id",admin,async req=>{
    const id=pluginIdSchema.parse(req.params.id),{enabled}=moduleSwitchSchema.parse(req.body);
    db.prepare("INSERT OR REPLACE INTO plugin_switches VALUES(?,?)").run(id,Number(enabled));return {id,enabled};
  });
  const mcp=(id:string)=>{
    const item=mcpEntries(db).find(m=>m.id===id);if(!item)throw fileError(404,"MCP 不存在。");return item;
  };
  app.get("/api/mcp",admin,async()=>mcpEntries(db));
  app.post("/api/mcp",admin,async(req,reply)=>{
    const input=safe(mcpInputSchema.parse(req.body)),id=randomUUID();
    db.prepare("INSERT INTO mcp_servers(id,name,url,enabled) VALUES(?,?,?,?)").run(id,input.name,input.url,+input.enabled);
    return reply.code(201).send(mcp(id));
  });
  app.patch<ById>("/api/mcp/:id",admin,async req=>{
    const old=mcp(req.params.id),input=safe((old.builtin?moduleSwitchSchema:mcpInputSchema.partial()).parse(req.body));
    const updated={...old,...input};
    db.prepare("UPDATE mcp_servers SET name=?,url=?,enabled=?,status='unknown',checked_at=NULL WHERE id=?")
      .run(updated.name,updated.url,+updated.enabled,old.id);
    return mcp(old.id);
  });
  app.delete<ById>("/api/mcp/:id",admin,async(req,reply)=>{
    if(mcp(req.params.id).builtin)throw fileError(409,"内置服务可停用。");
    db.prepare("DELETE FROM mcp_servers WHERE id=?").run(req.params.id);return reply.code(204).send();
  });
  app.post<ById>("/api/mcp/:id/probe",admin,async req=>{
    const item=mcp(req.params.id);if(!item.enabled)throw fileError(409,"请先启用此服务。");
    const ok=await probeMcp(item,opsEntry,ctx.gatewayConfig.port);
    db.prepare("UPDATE mcp_servers SET status=?,checked_at=? WHERE id=? AND url IS ? AND enabled=1")
      .run(ok?"online":"offline",new Date().toISOString(),item.id,item.url);return mcp(item.id);
  });
  app.get("/api/usage/today",admin,async()=>{
    const date=new Date().toISOString().slice(0,10);
    return {date,...db.prepare(`SELECT count(*) requests,total(cost_usd) cost_usd,total(cost_cny) cost_cny,
      total(input_tokens+output_tokens) tokens FROM usage_logs WHERE created_at>=? AND created_at<?`)
      .get(date,date+"T24:00:00Z") as object};
  });
  app.post("/api/threads/archive",admin,async req=>{
    const {ids,archived}=sessionArchiveSchema.parse(req.body),unique=[...new Set(ids)];
    db.transaction(()=>{
      for(const id of unique){
        if(archived && db.prepare("SELECT 1 FROM tasks WHERE thread_id=? AND status IN ('queued','running')").get(id))
          throw fileError(409,"请先结束运行中的会话。");
        checkChanges(db.prepare("UPDATE threads SET archived=? WHERE id=?").run(+archived,id).changes);
      }
    }).immediate();return {count:unique.length,archived};
  });
  app.get("/api/threads/archived",admin,async()=>db.prepare("SELECT id,title,workspace_id,updated_at FROM threads WHERE archived=1 ORDER BY updated_at DESC").all());
  app.post<ById>("/api/threads/:id/fork",admin,async(req,reply)=>{
    const source=db.prepare("SELECT title,workspace_id,active_model_alias,handoff_doc,compacted_summary FROM threads WHERE id=?").get(req.params.id) as
      {title:string;workspace_id:string;active_model_alias:string;handoff_doc:string|null;compacted_summary:string|null}|undefined;
    if(!source)throw fileError(404,"会话不存在。");
    const result=db.transaction(()=>{
      const parts=[source.handoff_doc,source.compacted_summary].filter(Boolean);
      let size=parts.join("\n").length;
      for(const item of db.prepare("SELECT prompt,coalesce(nullif(answer_markdown,''),summary) answer FROM tasks WHERE thread_id=? AND status='completed' ORDER BY rowid").iterate(req.params.id) as Iterable<{prompt:string;answer:string}>){
        const text="用户\n"+item.prompt+"\n\n助手\n"+item.answer;
        size+=text.length;if(size>180000)throw fileError(413,"会话过长，请使用架构交接单开新会话。");parts.push(text);
      }
      const child=manager.createThread(source.workspace_id,source.active_model_alias,(source.title+" · 分支").slice(0,240));
      const baseline=ctx.masker.maskString(parts.join("\n\n"));
      db.prepare("UPDATE threads SET parent_thread_id=?,handoff_doc=? WHERE id=?").run(req.params.id,baseline,child.id);
      return {...child,parent_thread_id:req.params.id,handoff_doc:baseline};
    }).immediate();return reply.code(201).send(result);
  });

  const skillRoute="/api/workspaces/:id/skills";
  app.get<ById&{Querystring:{scope?:string}}>(skillRoute,admin,async req=>{
    const scope=skillFileSchema.shape.scope.parse(req.query.scope??"project"),root=await files.instructionRoot(req.params.id,scope);
    const dir=await resolveSafeWorkspacePath(root,".agents/skills");
    const dirs=await readdir(dir,{withFileTypes:true}).catch(e=>{if(missing(e))return [];throw e;});
    const names:string[]=[];
    for(const d of dirs){
      if(!d.isDirectory()||!skillFileSchema.shape.name.safeParse(d.name).success)continue;
      try{const file=await readEditable(root,".agents/skills/"+d.name+"/SKILL.md",ctx.masker);if(file)names.push(d.name);}
      catch(e){if((e as {statusCode?:number}).statusCode!==404)throw e;}
    }
    return names.sort();
  });
  const skillParams=async(id:string,name:string,scope?:string)=>{
    const input=skillFileSchema.parse({name,scope:scope??"project"});
    return {root:await files.instructionRoot(id,input.scope),path:".agents/skills/"+name+"/SKILL.md"};
  };
  type SkillReq={Params:{id:string;name:string};Querystring:{scope?:string}};
  app.get<SkillReq>(skillRoute+"/:name",admin,async req=>{
    const target=await skillParams(req.params.id,req.params.name,req.query.scope);
    return readEditable(target.root,target.path,ctx.masker);
  });
  app.put<SkillReq>(skillRoute+"/:name",admin,async req=>{
    const target=await skillParams(req.params.id,req.params.name,req.query.scope);
    const {content}=z.object({content:z.string().min(1).max(65536)}).strict().parse(req.body);
    const revision=await writeEditable(target.root,target.path,safe(content),req.headers["if-match"],ctx.masker);
    db.prepare("INSERT OR REPLACE INTO settings VALUES('modules.instructions.revision',?,?)").run(randomUUID(),new Date().toISOString());return {revision};
  });
  app.delete<SkillReq>(skillRoute+"/:name",admin,async(req,reply)=>{
    const target=await skillParams(req.params.id,req.params.name,req.query.scope);
    const current=await readEditable(target.root,target.path,ctx.masker);
    if(current.revision!==req.headers["if-match"])throw fileError(409,"技能文件已更新，请重新打开。");
    await unlink(await resolveSafeWorkspacePath(target.root,target.path));
    db.prepare("INSERT OR REPLACE INTO settings VALUES('modules.instructions.revision',?,?)").run(randomUUID(),new Date().toISOString());
    return reply.code(204).send();
  });
}
