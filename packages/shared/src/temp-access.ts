import { z } from "zod";

export const guestPermission = z.enum(["readonly","collab_restricted","full_with_approval"]);
const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cost = z.number().positive().max(1e12);
export const tempLinkCreate = z.object({
  name:z.string().trim().min(1).max(120), workspace_ids:z.array(z.string().min(1).max(128)).min(1).max(100),
  permission:guestPermission, expires_at:z.iso.datetime({offset:true}), require_code:z.boolean().default(false),
  bind_first_ip:z.boolean().default(false), note:z.string().max(1000).default(""),
  max_turns:count.nullish(), max_tokens:count.nullish(), max_cost:cost.nullish(), currency:z.enum(["USD","CNY"]).default("USD"),
}).strict();
export const tempLinkExtend = z.object({
  hours:z.number().positive().max(87600).optional(), turns:count.optional(), tokens:count.optional(), cost:cost.optional(),
}).strict().refine(p=>Object.keys(p).length>0);
export const tempLinkSchema = tempLinkCreate.omit({require_code:true}).extend({
  id:z.string(), has_code:z.boolean(), usage_unconfirmed:z.boolean(),bound_ip:z.string().nullable(), created_at:z.string(),
  status:z.enum(["active","revoked","expired","exhausted"]), used_turns:z.number(),used_tokens:z.number(),used_cost:z.number(),
});
export type TempAccessLink = z.infer<typeof tempLinkSchema>;

const relativePath=z.string().min(1).max(512);
export const guestTools={
  read_file:z.object({path:relativePath}).strict(),
  write_file:z.object({path:relativePath,content:z.string().max(100000),revision:z.string().max(64)}).strict(),
  stage_static:z.object({public_dir:relativePath}).strict(),
};
const descriptions={read_file:"Read text within this workspace and its revision.",write_file:"Submit an exact file revision for administrator approval. Use missing for a new file.",stage_static:"Request administrator approval to stage a static workspace directory."};
export const guestToolDefinitions=Object.entries(guestTools).map(([name,schema])=>({type:"function",name,
  description:descriptions[name as keyof typeof guestTools],parameters:z.toJSONSchema(schema)}));
