import type Database from "better-sqlite3";
import {projectEvent,projectTurn,type ThreadEvent,type TurnTelemetry} from "@codexdeck/shared";
import type { SecretMasker } from "../security/secret-masker.js";

/** Older databases may contain individually harmless fragments that reveal a secret when joined. */
export function safeAnswerFragments(events:ThreadEvent[],masker:SecretMasker) {
  const groups=new Map<string,{seq:number;delta:string}[]>();
  for(const event of events) {
    if(event.type!=="item/agentMessage/delta") continue;
    const p=event.payload as {itemId?:string;delta?:string};
    if(typeof p?.delta!=="string") continue;
    const id=p.itemId??"", group=groups.get(id)??[];
    group.push({seq:event.seq_id,delta:p.delta});groups.set(id,group);
  }
  const replacements=new Map<number,string>();
  for(const parts of groups.values()) {
    const joined=parts.map(p=>p.delta).join(""),safe=masker.maskString(joined);
    if(safe!==joined) parts.forEach(({seq},i)=>replacements.set(seq,i===0?safe:""));
  }
  return replacements;
}

export function turnEvents(db:Database.Database,thread:string,task:string,masker:SecretMasker,debug=false) {
  const rows=db.prepare(`SELECT thread_id,task_id,sequence AS seq_id,type,payload_json,created_at FROM thread_events
    WHERE thread_id=? AND task_id=? ORDER BY sequence`).all(thread,task) as Array<Omit<ThreadEvent,"payload">&{payload_json:string}>;
  const frames=rows.map(({payload_json,...base})=>({...base,payload:JSON.parse(payload_json)}));
  const replacements=safeAnswerFragments(frames,masker);
  return frames.flatMap(frame=>{
    if (replacements.has(frame.seq_id)) frame.payload={...frame.payload,delta:replacements.get(frame.seq_id)};
    const event=projectEvent({...frame,payload:masker.maskObject(frame.payload)},debug);
    return event?[event]:[];
  });
}
export function turnMetrics(db:Database.Database,thread:string,task:string,start:number,files:TurnTelemetry["files"],diff:string):TurnTelemetry {
  const row=db.prepare(`SELECT sum(CASE WHEN usage_known THEN input_tokens END) input_tokens,
    sum(CASE WHEN usage_known THEN output_tokens END) output_tokens,sum(CASE WHEN usage_known THEN cost_usd END) cost_usd,
    sum(CASE WHEN usage_known THEN cost_cny END) cost_cny,
    1.0*sum(cached_input_tokens)/nullif(sum(CASE WHEN cached_input_tokens IS NOT NULL THEN input_tokens END),0) cache_hit_rate,
    sum(CASE WHEN tokens_per_sec>0 THEN output_tokens END)/nullif(sum(CASE WHEN tokens_per_sec>0 THEN output_tokens/tokens_per_sec END),0) tokens_per_sec
    FROM usage_logs WHERE turn_id=?`).get(task) as Pick<TurnTelemetry,"input_tokens"|"output_tokens"|"cache_hit_rate"|"cost_usd"|"cost_cny"|"tokens_per_sec">;
  const source=db.prepare(`SELECT coalesce((SELECT m.alias FROM usage_logs u JOIN models m ON m.id=u.model_id
    WHERE u.turn_id=? AND u.status_code BETWEEN 200 AND 299 ORDER BY u.rowid DESC LIMIT 1),t.active_model_alias) model,
    t.last_context_tokens context_tokens FROM threads t WHERE t.id=?`).get(task,thread) as Pick<TurnTelemetry,"model"|"context_tokens">;
  return {...row,...source,files,diff,elapsed_ms:Math.max(0,Date.now()-start)};
}

export function completeAnswer(db:Database.Database,thread:string,task:string,masker:SecretMasker) {
  return masker.maskString(projectTurn(turnEvents(db,thread,task,masker)).answer);
}
