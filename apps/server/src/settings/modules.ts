import type Database from "better-sqlite3";
import type {McpEntry,PluginId} from "@codexdeck/shared";

export function pluginEnabled(db:Database.Database,id:PluginId) {
  return db.prepare("SELECT enabled FROM plugin_switches WHERE id=?").pluck().get(id)!==0;
}
export function mcpEntries(db:Database.Database):McpEntry[] {
  const rows=db.prepare("SELECT * FROM mcp_servers ORDER BY url IS NOT NULL,name,id").all() as (Omit<McpEntry,"enabled"|"builtin">&{enabled:number})[];
  return rows.map(row=>({...row,enabled:Boolean(row.enabled),builtin:row.id==="codexdeck_ops"}));
}
