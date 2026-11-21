import type Database from "better-sqlite3";
import { projectTurn, type ThreadEvent, type TurnPage, type TurnSnapshot, type TurnStep } from "@codexdeck/shared";
import type { SecretMasker } from "../security/secret-masker.js";
import { rawTurnEvents } from "./timeline.js";
import { saveAnswerArchive } from "./answer-archive.js";

type TurnRow = {
  id:string; thread_id:string; turn_index:number; client_msg_id:string|null; user_content:string;
  assistant_markdown:string|null; timeline_summary_json:string|null; artifacts_summary_json:string|null;
  telemetry_json:string|null; summary_only:number; state:TurnSnapshot["status"]; latest_seq_id:number;
  created_at:string; updated_at:string; checkpoint_ref:string|null;
};
const selectTurn = `SELECT s.id,s.thread_id,s.turn_index,s.client_msg_id,s.user_content,s.assistant_markdown,
  s.timeline_summary_json,s.artifacts_summary_json,s.telemetry_json,s.summary_only,t.status state,
  s.latest_seq_id,s.created_at,t.updated_at,c.ref checkpoint_ref
  FROM thread_turns s JOIN tasks t ON t.id=s.id LEFT JOIN checkpoints c ON c.turn_id=s.id`;
const running = (status:TurnSnapshot["status"])=>status==="running" || status==="queued";

export function latestThreadSequence(db:Database.Database,thread:string) {
  return db.prepare(`SELECT max(coalesce((SELECT max(sequence) FROM thread_events WHERE thread_id=?),0),
    coalesce((SELECT max(latest_seq_id) FROM thread_turns WHERE thread_id=?),0))`).pluck().get(thread,thread) as number;
}

function turnArtifacts(db:Database.Database,row:TurnRow) {
  return db.prepare(`SELECT id,name,path,workspace_id,thread_id,turn_id,mime_type,change_type,size_bytes,created_at
    FROM artifacts WHERE thread_id=? AND turn_id=? ORDER BY rowid`).all(row.thread_id,row.id) as TurnSnapshot["artifacts"];
}

function snapshot(db:Database.Database,row:TurnRow,masker:SecretMasker):TurnSnapshot {
  const base = {id:row.id,thread_id:row.thread_id,turn_index:row.turn_index,client_msg_id:row.client_msg_id,
    user_content:row.user_content,created_at:row.created_at,updated_at:row.updated_at,status:row.state,
    checkpoint_ref:row.checkpoint_ref,latest_seq_id:row.latest_seq_id};
  if (row.timeline_summary_json!==null) {
    const artifacts=row.artifacts_summary_json===null ? turnArtifacts(db,row) : JSON.parse(row.artifacts_summary_json);
    if(row.artifacts_summary_json===null) db.prepare("UPDATE thread_turns SET artifacts_summary_json=? WHERE id=?").run(JSON.stringify(artifacts),row.id);
    return {...base,assistant_markdown:row.assistant_markdown??"",timeline:JSON.parse(row.timeline_summary_json),
      artifacts,telemetry:JSON.parse(row.telemetry_json??"null"),summary_only:row.state==="completed" && !!row.assistant_markdown?.trim() && !!row.summary_only};
  }
  const frames=rawTurnEvents(db,row.thread_id,row.id,masker,true);
  const view=projectTurn(frames);
  // Credentials are masked again after assembling legacy text split between events.
  const task=db.prepare("SELECT answer_markdown,summary FROM tasks WHERE id=?").get(row.id) as {answer_markdown:string|null;summary:string};
  const answer=masker.maskString(task.answer_markdown || view.answer || task.summary);
  const summaryOnly=row.state==="completed" && !task.answer_markdown && !view.answer && !!task.summary.trim();
  const timeline=view.items.map(item=>item.operations?
    {...item,operations:item.operations.map(operation=>({...operation,detail:""}))}:item);
  const telemetry=view.telemetry ? {...view.telemetry,diff:""} : null;
  const artifacts=turnArtifacts(db,row);
  const seq=db.prepare("SELECT coalesce(max(sequence),0) FROM thread_events WHERE task_id=?").pluck().get(row.id) as number;
  if (!running(row.state)) {
    const update=db.prepare(`UPDATE thread_turns SET assistant_markdown=?,timeline_summary_json=?,artifacts_summary_json=?,
      telemetry_json=?,summary_only=?,status=?,latest_seq_id=?,updated_at=? WHERE id=?`);
    update.run(answer,JSON.stringify(timeline),JSON.stringify(artifacts),JSON.stringify(telemetry),Number(summaryOnly),row.state,seq,row.updated_at,row.id);
    saveAnswerArchive(db,row.id,frames);
  }
  return {...base,assistant_markdown:answer,timeline,artifacts,telemetry,summary_only:summaryOnly,latest_seq_id:seq,
    ...(running(row.state) && {active_answer_items:view.answerItems})};
}

/** Called inside the same SQLite transaction that persists the terminal event. */
export function materializeTurn(db:Database.Database,thread:string,id:string,masker:SecretMasker) {
  const row=db.prepare(selectTurn+" WHERE s.thread_id=? AND s.id=?").get(thread,id) as TurnRow|undefined;
  if(row) snapshot(db,row,masker);
}

export function turnPage(db:Database.Database,thread:string,limit:number,before:number,masker:SecretMasker):TurnPage {
  return db.transaction(()=>{
    const rows=db.prepare(selectTurn+" WHERE s.thread_id=? AND s.turn_index<? ORDER BY s.turn_index DESC LIMIT ?")
      .all(thread,before,limit+1) as TurnRow[];
    const turns=rows.slice(0,limit).reverse().map(row=>snapshot(db,row,masker));
    const activeRow=db.prepare(selectTurn+" WHERE s.thread_id=? AND t.status='running' LIMIT 1").get(thread) as TurnRow|undefined;
    const active=activeRow ? turns.find(turn=>turn.id===activeRow.id)??snapshot(db,activeRow,masker) : null;
    const seq=latestThreadSequence(db,thread);
    return {turns,has_more:rows.length>limit,active_turn:active,latest_seq_id:seq};
  })();
}

export function stepDetail(db:Database.Database,id:string,step:string,masker:SecretMasker):TurnStep|undefined {
  if (step==="$diff") {
    const stored=db.prepare("SELECT turn_diff_json FROM tasks WHERE id=?").pluck().get(id) as string|null|undefined;
    if(stored===undefined) return;
    const latest=db.prepare(`SELECT json_extract(payload_json,'$.diff') FROM thread_events WHERE task_id=? AND type='turn/diff/updated'
      ORDER BY sequence DESC LIMIT 1`).pluck().get(id);
    const final=stored?JSON.parse(stored).diff:"";
    const detail=typeof latest==="string" && latest.startsWith(final) ? latest : final;
    return {id:step,detail:masker.maskString(detail)};
  }
  const rows=db.prepare(`SELECT thread_id,task_id,sequence AS seq_id,type,payload_json,created_at FROM thread_events
    WHERE task_id=? AND (json_extract(payload_json,'$.item.id')=? OR json_extract(payload_json,'$.itemId')=?)
    ORDER BY sequence`).all(id,step,step) as Array<Omit<ThreadEvent,"payload">&{payload_json:string}>;
  const frames=rows.map(({payload_json,...meta})=>({...meta,payload:masker.maskObject(JSON.parse(payload_json))}));
  const operation=projectTurn(frames).items.flatMap(item=>item.operations??[]).find(op=>op.id===step);
  if (!operation) return;
  const command=frames.find(frame=>frame.payload.item?.type==="commandExecution")?.payload.item.command;
  if(typeof command==="string") {
    const output=frames.filter(frame=>frame.type==="item/commandExecution/outputDelta" && typeof frame.payload.delta==="string");
    const complete=frames.filter(frame=>frame.type==="item/completed").at(-1)?.payload.item?.aggregatedOutput;
    const streamed=output.map(frame=>frame.payload.delta).join("");
    const retained=typeof complete==="string" && complete.length>=streamed.length ? complete : streamed;
    const result:TurnStep={id:step,command,detail:[command,retained].filter(Boolean).join("\n")};
    for(const stream of ["stdout","stderr"] as const) {
      const chunks=output.filter(frame=>frame.payload.stream===stream);
      if(chunks.length) result[stream]=chunks.map(frame=>frame.payload.delta).join("");
    }
    return masker.maskObject(result);
  }
  const change=frames.reverse().find(frame=>frame.type==="item/completed" && frame.payload.item?.type==="fileChange");
  const changes=change?.payload.item?.changes as {path?:string;diff?:string}[]|undefined;
  const details=changes?.map(file=>[file.path,file.diff].filter(Boolean).join("\n")).join("\n") || operation.detail;
  return {id:step,detail:masker.maskString(details)};
}
