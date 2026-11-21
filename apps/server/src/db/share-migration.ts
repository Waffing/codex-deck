export const shareMigrationSql = `
CREATE TABLE IF NOT EXISTS public_shares (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  rel_path TEXT NOT NULL, title TEXT NOT NULL, share_type TEXT NOT NULL,
  content_sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  passcode_hash TEXT, expires_at TEXT NOT NULL, max_views INTEGER CHECK(max_views > 0),
  view_count INTEGER NOT NULL DEFAULT 0, allow_download INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_share_reads (
  session_id TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES public_shares(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_public_share_reads_expiry ON public_share_reads(expires_at);
`;
