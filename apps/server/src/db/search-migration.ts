const sources = [
  ["thread_turns","messages","thread_id,turn_index,user_content,assistant_markdown"],
  ["artifacts","artifacts","workspace_id,thread_id,name,path,mime_type"],
  ["deployments","deployments","workspace_id,status,config_json"],
] as const;

function mark(type: string, id: string) {
  return `INSERT INTO search_entries(entity_type,entity_id) VALUES('${type}',${id})
    ON CONFLICT(entity_type,entity_id) DO UPDATE SET dirty=1;`;
}

export const searchMigrationSql = `
  CREATE TABLE search_entries (
    id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    dirty INTEGER NOT NULL DEFAULT 1, UNIQUE(entity_type,entity_id)
  );
  CREATE INDEX search_pending ON search_entries(id) WHERE dirty=1;
  CREATE VIRTUAL TABLE global_search_fts USING fts5(
    entity_type, entity_id UNINDEXED, workspace_id UNINDEXED, thread_id UNINDEXED,
    turn_index UNINDEXED, title, content, tokenize='trigram'
  );
  CREATE VIRTUAL TABLE global_search_short USING fts5(grams,content='',contentless_delete=1);
  INSERT INTO global_search_fts(global_search_fts,rank) VALUES('secure-delete',1);
  INSERT INTO global_search_short(global_search_short,rank) VALUES('secure-delete',1);
  ${sources.map(([table,type,columns]) => `
    CREATE TRIGGER search_${table}_add AFTER INSERT ON ${table} BEGIN ${mark(type,"NEW.id")} END;
    CREATE TRIGGER search_${table}_edit AFTER UPDATE OF ${columns} ON ${table} BEGIN ${mark(type,"NEW.id")} END;
    CREATE TRIGGER search_${table}_remove AFTER DELETE ON ${table} BEGIN ${mark(type,"OLD.id")} END;
  `).join("\n")}
  CREATE TRIGGER search_task_answer AFTER UPDATE OF summary,answer_markdown ON tasks
    BEGIN ${mark("messages","NEW.id")} END;
`;

// Queue IDs only. Reconstructing and redacting the contents runs in bounded batches after startup.
export const queueHistoricalSearch = sources.map(([table,type]) =>
  `INSERT INTO search_entries(entity_type,entity_id) SELECT '${type}',id FROM ${table} WHERE true
   ON CONFLICT(entity_type,entity_id) DO UPDATE SET dirty=1;`).join("\n");
