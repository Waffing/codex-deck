import type Database from "better-sqlite3";
import { projectTurn, type Artifact, type GlobalSearchHit, type SearchQuery, type SearchResults } from "@codexdeck/shared";
import { rawTurnEvents } from "../codex/timeline.js";
import type { SecretMasker } from "../security/secret-masker.js";
import { queueHistoricalSearch } from "./search-migration.js";

type Kind = GlobalSearchHit["entity_type"];
type Entry = { id: number; entity_type: Kind; entity_id: string };
type Document = { workspace_id: string | null; thread_id: string | null; turn_index: number | null; title: string; content: string };
const kinds: Kind[] = ["messages","artifacts","deployments"];

function gram(char: string) { return char.codePointAt(0)!.toString(16); }
function shortGrams(text: string) {
  const grams = new Set<string>();
  let previous = "";
  for (const char of text.toLowerCase()) {
    const next = gram(char);
    grams.add(next);
    if (previous) grams.add(previous+"x"+next);
    previous = next;
  }
  return [...grams].join(" ");
}
function phrase(query: string) {
  const chars = [...query.toLowerCase()];
  return chars.length < 3
    ? { table: "global_search_short", term: chars.map(gram).join("x") }
    : { table: "global_search_fts", term: '"'+query.replaceAll('"','""')+'"' };
}
function snippet(doc: Document, query: string) {
  const lower = query.toLowerCase();
  const text = doc.content.toLowerCase().includes(lower) ? doc.content : doc.title;
  const offset = text.toLowerCase().indexOf(lower);
  if (offset < 0) return [{ text: text.slice(0,150), match: false }];
  const end = offset+query.length;
  return [
    { text: (offset>45?"…":"")+text.slice(Math.max(0,offset-45),offset), match:false },
    { text: text.slice(offset,end), match:true },
    { text: text.slice(end,end+100)+(text.length>end+100?"…":""), match:false },
  ].filter(part=>part.text);
}

export class GlobalSearch {
  constructor(private db: Database.Database, private masker: SecretMasker) {
    if (!db.prepare("SELECT rowid FROM global_search_fts LIMIT 1").get()) db.transaction(()=>db.exec(queueHistoricalSearch))();
    masker.observeLiterals(value => this.redactExisting(value));
  }

  close() { this.masker.observeLiterals(); }

  private clear(rowid: number) {
    this.db.prepare("DELETE FROM global_search_fts WHERE rowid=?").run(rowid);
    this.db.prepare("DELETE FROM global_search_short WHERE rowid=?").run(rowid);
  }

  private write(entry: Entry, doc: Document) {
    const title = this.masker.maskString(doc.title), content = this.masker.maskString(doc.content);
    this.db.prepare("INSERT INTO global_search_fts(rowid,entity_type,entity_id,workspace_id,thread_id,turn_index,title,content) VALUES(?,?,?,?,?,?,?,?)")
      .run(entry.id,entry.entity_type,entry.entity_id,doc.workspace_id,doc.thread_id,doc.turn_index,title,content);
    this.db.prepare("INSERT INTO global_search_short(rowid,grams) VALUES(?,?)").run(entry.id,entry.entity_type+" "+shortGrams(title+"\n"+content));
  }

  private redactExisting(secret: string) {
    // Query only a prefix. Recheck the literal against each candidate before rewriting.
    const prefix = [...secret.split("\0",1)[0]].slice(0,24).join("");
    const { table, term } = phrase(prefix);
    const candidate = prefix ? `AND f.rowid IN (SELECT rowid FROM ${table} WHERE ${table} MATCH ?)` : "";
    const result = this.db.prepare(`SELECT f.rowid id,f.* FROM global_search_fts f WHERE f.rowid>? ${candidate}
      AND (instr(f.content,?)>0 OR instr(f.title,?)>0) ORDER BY f.rowid LIMIT 64`);
    this.db.transaction(() => {
      let cursor=0;
      while (true) {
        const rows=result.all(cursor,...(prefix?[term]:[]),secret,secret) as (Entry & Document)[];
        for(const row of rows){ this.clear(row.id); this.write(row,row); }
        if(rows.length<64)break;
        cursor=rows[rows.length-1].id;
      }
    })();
  }

  private source(entry: Entry): Document | undefined {
    if (entry.entity_type==="messages") {
      const row = this.db.prepare(`SELECT t.workspace_id,s.thread_id,s.turn_index,s.user_content title,
        coalesce(nullif(t.answer_markdown,''),nullif(s.assistant_markdown,'')) answer,t.summary
        FROM thread_turns s JOIN tasks t ON t.id=s.id WHERE s.id=?`).get(entry.entity_id) as
        (Omit<Document,"content"> & {thread_id:string; answer:string|null; summary:string})|undefined;
      if (!row) return;
      const content = row.answer || projectTurn(rawTurnEvents(this.db,row.thread_id,entry.entity_id,this.masker,true)).answer || row.summary;
      return {...row,content};
    }
    if (entry.entity_type==="artifacts") {
      return this.db.prepare(`SELECT a.workspace_id,a.thread_id,t.turn_index,a.name title,a.path content
        FROM artifacts a LEFT JOIN thread_turns t ON t.id=a.turn_id WHERE a.id=? AND a.workspace_id IS NOT NULL`)
        .get(entry.entity_id) as Document|undefined;
    }
    // Explicitly project public-facing deployment fields. Runtime arguments and verification logs may contain secrets.
    return this.db.prepare(`SELECT d.workspace_id,
      json_extract(d.config_json,'$.thread') thread_id,NULL turn_index,
      coalesce(w.name,d.id)||' · '||d.status title,
      concat_ws(' ',d.id,d.status,json_extract(d.config_json,'$.mode'),json_extract(d.config_json,'$.image'),
        json_extract(d.config_json,'$.port'),json_extract(d.config_json,'$.start.public_dir')) content
      FROM deployments d LEFT JOIN workspaces w ON w.id=d.workspace_id WHERE d.id=? AND json_valid(d.config_json)`)
      .get(entry.entity_id) as Document|undefined;
  }

  drain(limit=24) {
    const pending = this.db.prepare("SELECT id,entity_id,entity_type FROM search_entries WHERE dirty=1 ORDER BY id LIMIT ?").all(limit) as Entry[];
    this.db.transaction(() => {
      for (const entry of pending) {
        this.clear(entry.id);
        const doc = this.source(entry);
        if (doc) {
          this.write(entry,doc);
          this.db.prepare("UPDATE search_entries SET dirty=0 WHERE id=?").run(entry.id);
        } else this.db.prepare("DELETE FROM search_entries WHERE id=?").run(entry.id);
      }
    })();
    return pending.length;
  }

  search({q,scope,workspace_id}: SearchQuery): SearchResults {
    const { table, term } = phrase(q);
    const results: SearchResults = {messages:[],artifacts:[],deployments:[],
      indexing:!!this.db.prepare("SELECT id FROM search_entries WHERE dirty=1 LIMIT 1").get()};
    for (const kind of scope==="all"?kinds:[scope]) {
      // Intersect the scope's posting list before touching rows, also for tiny Chinese queries.
      const scopedTerm = table==="global_search_fts" ? `entity_type:"${kind}" AND {title content}: ${term}` : kind+" AND "+term;
      const rows = this.db.prepare(`SELECT f.* FROM ${table}(?) hits
        JOIN search_entries e ON e.id=hits.rowid JOIN global_search_fts f ON f.rowid=hits.rowid
        WHERE e.entity_type=? AND e.dirty=0 ${workspace_id?"AND f.workspace_id=?":""}
        ORDER BY hits.rowid DESC LIMIT 12`)
        .all(scopedTerm,kind,...(workspace_id?[workspace_id]:[])) as (Entry&Document)[];
      for (const row of rows) {
        const hit: GlobalSearchHit = {entity_type:kind,entity_id:row.entity_id,workspace_id:row.workspace_id,
          thread_id:row.thread_id,turn_index:row.turn_index,title:row.title.slice(0,200),snippet:snippet(row,q)};
        if (kind==="artifacts") {
          const artifact = this.db.prepare(`SELECT id,workspace_id,thread_id,turn_id,name,path,change_type,size_bytes,mime_type,created_at
            FROM artifacts WHERE id=?`).get(row.entity_id) as Artifact|undefined;
          if (!artifact) continue;
          hit.artifact={...artifact,name:this.masker.maskString(artifact.name),path:this.masker.maskString(artifact.path),
            mime_type:artifact.mime_type && this.masker.maskString(artifact.mime_type)};
        }
        results[kind].push(hit);
      }
    }
    return results;
  }
}
