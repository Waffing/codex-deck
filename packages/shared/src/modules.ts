import {z} from "zod";

export const promptTemplateSchema=z.object({
  name:z.string().trim().min(1).max(80), content:z.string().trim().min(1).max(32768),
}).strict();
export type PromptTemplate=z.infer<typeof promptTemplateSchema>&{id:string};
export const pluginIdSchema=z.enum(["auto_verify","playwright","smart_artifacts","document_viewer","global_search"]);
export type PluginId=z.infer<typeof pluginIdSchema>;
export const moduleSwitchSchema=z.object({enabled:z.boolean()}).strict();
export const mcpInputSchema=z.object({
  name:z.string().trim().min(1).max(80),
  url:z.url().max(2048).refine(value=>{
    const u=new URL(value);
    return u.protocol==="https:" && !u.username && !u.password && !u.search && !u.hash;
  },"Use an HTTPS endpoint without embedded credentials or query parameters."),
  enabled:z.boolean().default(true),
}).strict();
export type McpEntry={id:string;name:string;url:string|null;enabled:boolean;builtin:boolean;status:"unknown"|"online"|"offline";checked_at:string|null};
export const skillFileSchema=z.object({
  scope:z.enum(["global","project"]), name:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
}).strict();
export const sessionArchiveSchema=z.object({ids:z.array(z.string().uuid()).min(1).max(200),archived:z.boolean()}).strict();
export type TodayUsage={date:string;cost_usd:number;cost_cny:number;tokens:number;requests:number};
