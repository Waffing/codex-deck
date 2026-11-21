import type {FastifyInstance} from "fastify";
import {artifactBatchSchema,artifactHubQuerySchema,type Artifact,type ArtifactHubItem,type ArtifactCategory} from "@codexdeck/shared";
import type {ServerContext} from "../app.js";
import {createRequireAdmin} from "../auth.js";
import {fileError,resolveSafeWorkspacePath} from "../files/sandbox.js";
import {signDownload} from "../files/signed-url.js";
import type {WorkspaceFiles} from "../files/workspace-files.js";
import {readPreferences} from "../settings/preferences.js";

function category(name:string):ArtifactCategory {
  if(/\.(xlsx?|xlsm|csv|tsv|ods)$/i.test(name))return "spreadsheet";
  if(/\.(svg|png|jpe?g|webp|gif|bmp|avif|tiff?|ico)$/i.test(name))return "image";
  if(/\.html?$/i.test(name))return "web";
  if(/\.(zip|tar|gz|7z|rar|bz2|xz|apk|exe|dmg)$/i.test(name))return "archive";
  if(/\.(docx?|pdf|pptx?|md|markdown|mmd|mermaid|txt|rtf|odt|mp[34])$/i.test(name))return "document";
  return "code";
}

export async function checkedBatch(files:WorkspaceFiles,ids:string[]) {
  const items:Artifact[]=[];
  for(const id of new Set(ids)){
    const [item]=files.artifactsFor({kind:"artifact",id});
    await resolveSafeWorkspacePath(await files.getRoot(item.workspace_id),item.path);
    const handle=await files.openArtifact(id);
    await handle.close();
    items.push(item);
  }
  return items;
}

export function registerArtifactHub(app:FastifyInstance,ctx:ServerContext,files:WorkspaceFiles) {
  const admin={preHandler:createRequireAdmin(ctx)};
  ctx.native.function("artifact_category",{deterministic:true},category);
  app.get("/api/artifacts/hub",admin,async(req,reply)=>{
    const parsed=artifactHubQuerySchema.safeParse(req.query);
    if(!parsed.success)throw fileError(400,"Invalid artifact filters.");
    const query=parsed.data;
    const filters:string[]=["a.workspace_id IS NOT NULL"],values:string[]=[];
    if(query.workspace_id){filters.push("a.workspace_id=?");values.push(query.workspace_id);}
    if(query.q){filters.push("instr(lower(a.name),lower(?))>0");values.push(query.q);}
    if(query.category!=="all"){filters.push("artifact_category(a.name)=?");values.push(query.category);}
    if(query.mode==="smart"){
      const ext=readPreferences(ctx.native).artifactExtensions;
      filters.push("a.change_type<>'upload' AND EXISTS (SELECT 1 FROM json_each(?) e WHERE lower(a.name) LIKE '%' || e.value)");
      values.push(JSON.stringify(ext));
    }
    const where=" WHERE "+filters.join(" AND ");
    const direction=query.sort==="newest"?"DESC":"ASC";
    const total=ctx.native.prepare("SELECT count(*) FROM artifacts a"+where).pluck().get(...values);
    const items=ctx.native.prepare(`SELECT a.id,a.name,a.path,a.mime_type,a.size_bytes,a.change_type,a.created_at,
      a.workspace_id,a.thread_id,a.turn_id,w.name AS workspace_name,t.title AS thread_title,artifact_category(a.name) AS category
      FROM artifacts a JOIN workspaces w ON w.id=a.workspace_id LEFT JOIN threads t ON t.id=a.thread_id `+where+
      ` ORDER BY a.created_at ${direction},a.id ${direction} LIMIT ? OFFSET ?`).all(...values,query.limit,query.offset) as ArtifactHubItem[];
    return reply.header("Cache-Control","private, no-store").send({total,items:items.map(item=>({...item,
      name:ctx.masker.maskString(item.name),path:ctx.masker.maskString(item.path),workspace_name:ctx.masker.maskString(item.workspace_name),
      thread_title:item.thread_title && ctx.masker.maskString(item.thread_title)}))});
  });
  app.post("/api/artifacts/hub/batch-sign",admin,async(req,reply)=>{
    const parsed=artifactBatchSchema.safeParse(req.body);
    if(!parsed.success)throw fileError(400,"Select between 1 and 64 artifacts.");
    const items=await checkedBatch(files,parsed.data.artifact_ids);
    return reply.header("Cache-Control","no-store").send({download_url:signDownload({kind:"batch",ids:items.map(item=>item.id)},ctx.masterKey,parsed.data.ttl_seconds)});
  });
}
