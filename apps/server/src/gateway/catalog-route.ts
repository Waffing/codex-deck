import type Database from "better-sqlite3";

// Advertise limits that every enabled route target can honor without restarting a Codex thread when it switches.
export function catalogModel(db:Database.Database,requested?:string|null){
  const alias=requested ?? db.prepare("SELECT slug FROM routing_profiles WHERE is_global_default=1 AND enabled=1 LIMIT 1").pluck().get() as string|undefined
    ?? db.prepare("SELECT value FROM settings WHERE key='default_model'").pluck().get() as string|undefined;
  const columns="m.alias,m.context_window,m.max_output_tokens,m.last_probe_json,m.protocol,m.capabilities_json,p.quirks_json";
  type Model={alias:string;context_window:number;max_output_tokens:number;last_probe_json:string|null;protocol:string;capabilities_json:string;quirks_json:string};
  const group=alias && db.prepare("SELECT targets_json FROM routing_profiles WHERE slug=? AND enabled=1").pluck().get(alias);
  if(typeof group==="string"){
    const targets=db.prepare(`SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id
      JOIN json_each(?) t ON m.id=json_extract(t.value,'$.model_id') WHERE p.enabled=1 AND m.enabled=1 ORDER BY t.key`).all(group) as Model[];
    if(!targets.length)return undefined;
    return {...targets[0],alias:alias!,context_window:Math.min(...targets.map(m=>m.context_window)),
      max_output_tokens:Math.min(...targets.map(m=>m.max_output_tokens)),last_probe_json:null,protocol:"auto",capabilities_json:"[]",quirks_json:"{}"};
  }
  return db.prepare(`SELECT ${columns} FROM models m JOIN providers p ON p.id=m.provider_id WHERE p.enabled AND m.enabled
    AND (? IS NULL OR m.alias=?) ORDER BY m.created_at,m.id LIMIT 1`).get(alias??null,alias??null) as Model|undefined;
}
