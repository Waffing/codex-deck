export const modulesMigrationSql=`
  CREATE TABLE prompt_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,content TEXT NOT NULL);
  CREATE TABLE plugin_switches(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
  CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT,enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unknown',checked_at TEXT);
  INSERT INTO mcp_servers(id,name) VALUES('codexdeck_ops','CodexDeck Ops');
  ALTER TABLE threads ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX threads_archive_order ON threads(archived,workspace_id,created_at);
`;
