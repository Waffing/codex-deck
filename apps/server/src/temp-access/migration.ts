export const guestMigration = {
  version:7,
  sql:`
    CREATE TABLE temp_access_links (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, code_hash TEXT,
      expires_at TEXT NOT NULL, workspace_ids_json TEXT NOT NULL, permission TEXT NOT NULL,
      max_turns INTEGER, used_turns INTEGER NOT NULL DEFAULT 0,
      max_tokens INTEGER, used_tokens INTEGER NOT NULL DEFAULT 0,
      max_cost REAL, used_cost REAL NOT NULL DEFAULT 0, currency TEXT NOT NULL,
      bind_first_ip INTEGER NOT NULL, bound_ip TEXT, first_visit TEXT, created_at TEXT NOT NULL, note TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', usage_unconfirmed INTEGER NOT NULL DEFAULT 0,
      failed_codes INTEGER NOT NULL DEFAULT 0, retry_after INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE guest_sessions (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, link_id TEXT NOT NULL REFERENCES temp_access_links(id) ON DELETE CASCADE,
      ip TEXT NOT NULL, last_seen_at TEXT NOT NULL, workspace_id TEXT
    );
    CREATE INDEX guest_sessions_link ON guest_sessions(link_id);
    ALTER TABLE tasks ADD COLUMN guest_link_id TEXT REFERENCES temp_access_links(id);
    CREATE INDEX guest_tasks ON tasks(guest_link_id,status) WHERE guest_link_id IS NOT NULL;
  `,
};
