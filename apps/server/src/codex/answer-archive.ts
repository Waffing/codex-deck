import type Database from "better-sqlite3";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ThreadEvent } from "@codexdeck/shared";

/** Keep exact replay cursors for public SSE while reclaiming thousands of indexed rows. */
type PackedFrame = [number, string, unknown];
export const answerDelta = "item/agentMessage/delta";

export function saveAnswerArchive(db:Database.Database, task:string, frames:ThreadEvent[]) {
  const deltas:PackedFrame[] = frames.filter(frame=>frame.type===answerDelta)
    .map(frame=>[frame.seq_id,frame.created_at,frame.payload]);
  if (!deltas.length) return;
  const packed = gzipSync(JSON.stringify(deltas), {level:1});
  db.prepare("INSERT INTO turn_answer_replay(turn_id,frames) VALUES(?,?)").run(task,packed);
  db.prepare("DELETE FROM thread_events WHERE task_id=? AND type=?").run(task,answerDelta);
}

export function archivedAnswers(db:Database.Database, thread:string, task:string):ThreadEvent[] {
  const data = db.prepare("SELECT a.frames FROM turn_answer_replay a JOIN thread_turns t ON t.id=a.turn_id WHERE t.thread_id=? AND a.turn_id=?")
    .pluck().get(thread,task) as Buffer|undefined;
  if (!data) return [];
  const parts:PackedFrame[] = JSON.parse(gunzipSync(data).toString("utf8"));
  return parts.map(([seq_id,created_at,payload])=>({thread_id:thread,task_id:task,type:answerDelta,seq_id,created_at,payload}));
}
