import type Database from "better-sqlite3";
import {gatewayMigrationSql} from "./gateway-migration.js";
import { guestMigration } from "../temp-access/migration.js";
import {searchMigrationSql} from "./search-migration.js";
import {shareMigrationSql} from "./share-migration.js";
import {modulesMigrationSql} from "./modules-migration.js";

export const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, preset TEXT NOT NULL, base_url TEXT NOT NULL,
        api_key_ciphertext TEXT, api_key_masked TEXT, headers_json TEXT NOT NULL, quirks_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, last_probe_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        alias TEXT NOT NULL UNIQUE, model_id TEXT NOT NULL, protocol TEXT NOT NULL DEFAULT 'auto',
        fallback_model_ids_json TEXT NOT NULL DEFAULT '[]',
        cost_input_usd_per_million REAL NOT NULL DEFAULT 0,
        cost_output_usd_per_million REAL NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread_events (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL, UNIQUE(thread_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        action TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY, thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
        name TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
        status TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
        scopes_json TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS usage_logs (
        id TEXT PRIMARY KEY, model_id TEXT, provider_id TEXT, requested_alias TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0, latency_ms INTEGER, status_code INTEGER,
        failover_from TEXT, error TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_channels (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_models_provider_id ON models(provider_id);
      CREATE INDEX IF NOT EXISTS idx_thread_events_thread_sequence ON thread_events(thread_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_usage_logs_created_at ON usage_logs(created_at);
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE workspaces ADD COLUMN automation_level TEXT NOT NULL DEFAULT 'conservative';
      ALTER TABLE workspaces ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';
      ALTER TABLE threads ADD COLUMN active_model_alias TEXT;
      ALTER TABLE threads ADD COLUMN reasoning_effort TEXT;
      ALTER TABLE threads ADD COLUMN session_rules_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE threads ADD COLUMN remote_thread_id TEXT;
      ALTER TABLE threads ADD COLUMN codex_home TEXT;
      ALTER TABLE approvals ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'high';
      ALTER TABLE artifacts ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE;
      ALTER TABLE artifacts ADD COLUMN turn_id TEXT;
      ALTER TABLE artifacts ADD COLUMN change_type TEXT NOT NULL DEFAULT 'modified';
      UPDATE artifacts SET workspace_id=(SELECT workspace_id FROM threads WHERE threads.id=artifacts.thread_id);
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued', summary TEXT NOT NULL DEFAULT '',
        api_key_id TEXT REFERENCES api_keys(id), webhook_url TEXT, webhook_state TEXT,
        webhook_attempts INTEGER NOT NULL DEFAULT 0, webhook_next_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE checkpoints (
        turn_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, ref TEXT NOT NULL, created_at TEXT NOT NULL
      );
      ALTER TABLE thread_events ADD COLUMN task_id TEXT;
      CREATE INDEX idx_thread_events_task ON thread_events(task_id,sequence);
      CREATE INDEX idx_tasks_workspace ON tasks(workspace_id,status);
      CREATE INDEX idx_artifacts_turn ON artifacts(turn_id,workspace_id);
      ALTER TABLE api_keys ADD COLUMN prefix TEXT NOT NULL DEFAULT '';
      ALTER TABLE api_keys ADD COLUMN workspace_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE api_keys ADD COLUMN rate_limit_rpm INTEGER NOT NULL DEFAULT 60;
      ALTER TABLE api_keys ADD COLUMN webhook_origins_json TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE models ADD COLUMN pricing_currency TEXT NOT NULL DEFAULT 'USD';
      ALTER TABLE models ADD COLUMN cost_input_cny_per_million REAL NOT NULL DEFAULT 0;
      ALTER TABLE models ADD COLUMN cost_output_cny_per_million REAL NOT NULL DEFAULT 0;
      ALTER TABLE usage_logs ADD COLUMN cost_cny REAL NOT NULL DEFAULT 0;
      ALTER TABLE approvals ADD COLUMN expires_at TEXT;
      ALTER TABLE deployments ADD COLUMN last_verification_json TEXT;
      CREATE INDEX IF NOT EXISTS idx_tasks_thread_created ON tasks(thread_id,created_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE models ADD COLUMN last_probe_json TEXT;
      ALTER TABLE artifacts ADD COLUMN content_sha256 TEXT;
      ALTER TABLE tasks ADD COLUMN image_ids_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE usage_logs ADD COLUMN task_id TEXT;
      ALTER TABLE usage_logs ADD COLUMN thread_id TEXT;
      ALTER TABLE usage_logs ADD COLUMN workspace_id TEXT;
      ALTER TABLE usage_logs ADD COLUMN usage_known INTEGER NOT NULL DEFAULT 0;
      UPDATE usage_logs SET usage_known=1 WHERE input_tokens>0 OR output_tokens>0;
      CREATE INDEX usage_logs_tasks ON usage_logs(workspace_id,task_id);
      CREATE TABLE task_submissions (
        api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        PRIMARY KEY(api_key_id,workspace_id,request_key)
      );
      CREATE TABLE admin_audit (
        id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT,
        details TEXT NOT NULL, status INTEGER NOT NULL, created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE providers ADD COLUMN api_keys_enc TEXT;
      ALTER TABLE providers ADD COLUMN balance_endpoint TEXT;
      ALTER TABLE providers ADD COLUMN balance_token_enc TEXT;
      ALTER TABLE providers ADD COLUMN balance_user_id TEXT;
      ALTER TABLE providers ADD COLUMN last_balance_json TEXT;
      ALTER TABLE providers ADD COLUMN rotation_strategy TEXT NOT NULL DEFAULT 'round_robin';
      ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 128000;
      ALTER TABLE models ADD COLUMN max_output_tokens INTEGER NOT NULL DEFAULT 16384;
      ALTER TABLE models ADD COLUMN cache_read_price_per_1m REAL NOT NULL DEFAULT 0;
      ALTER TABLE models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE models ADD COLUMN last_benchmark_json TEXT;
      ALTER TABLE usage_logs ADD COLUMN cached_input_tokens INTEGER;
      ALTER TABLE usage_logs ADD COLUMN ttft_ms INTEGER;
      ALTER TABLE usage_logs ADD COLUMN tokens_per_sec REAL;
      ALTER TABLE usage_logs ADD COLUMN turn_id TEXT;
      UPDATE usage_logs SET turn_id=task_id WHERE task_id IS NOT NULL;
      CREATE INDEX usage_logs_turn ON usage_logs(turn_id);
      ALTER TABLE threads ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN last_context_tokens INTEGER;
      ALTER TABLE threads ADD COLUMN compacted_summary TEXT;
      ALTER TABLE tasks ADD COLUMN answer_markdown TEXT;
      ALTER TABLE tasks ADD COLUMN turn_diff_json TEXT;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE user_sessions (
        session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, ip TEXT NOT NULL, user_agent TEXT NOT NULL,
        created_at TEXT NOT NULL,last_active_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX sessions_device ON user_sessions(ip,user_agent);
      INSERT INTO user_sessions SELECT lower(hex(randomblob(16))),substr(key,9),'','',updated_at,updated_at,value,0
        FROM settings WHERE key GLOB 'session:*' AND value>strftime('%Y-%m-%dT%H:%M:%fZ','now');
      DELETE FROM settings WHERE key GLOB 'session:*';
      CREATE TABLE login_bans (ip TEXT PRIMARY KEY, failures INTEGER NOT NULL, banned_until INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY, event TEXT NOT NULL, actor TEXT NOT NULL, ip TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `,
  },
  guestMigration,
  {
    version: 8,
    sql: `
      ALTER TABLE artifacts ADD COLUMN size_bytes INTEGER;
      ALTER TABLE threads ADD COLUMN executor_mode TEXT NOT NULL DEFAULT 'standard';
      CREATE INDEX idx_artifacts_thread_turn ON artifacts(thread_id,turn_id);
      CREATE TABLE thread_turns (
        id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_index INTEGER NOT NULL, client_msg_id TEXT, request_hash TEXT, user_content TEXT NOT NULL,
        assistant_markdown TEXT, timeline_summary_json TEXT, artifacts_summary_json TEXT, telemetry_json TEXT,
        summary_only INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, latest_seq_id INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_turns_thread_index ON thread_turns(thread_id,turn_index DESC);
      CREATE INDEX idx_turns_thread_sequence ON thread_turns(thread_id,latest_seq_id DESC);
      CREATE INDEX idx_tasks_running_thread ON tasks(thread_id) WHERE status='running';
      CREATE UNIQUE INDEX idx_turns_client ON thread_turns(thread_id,client_msg_id) WHERE client_msg_id IS NOT NULL;
      CREATE TABLE turn_answer_replay (
        turn_id TEXT PRIMARY KEY REFERENCES thread_turns(id) ON DELETE CASCADE, frames BLOB NOT NULL
      );
      INSERT INTO thread_turns(id,thread_id,turn_index,user_content,status,created_at,updated_at)
        SELECT id,thread_id,row_number() OVER (PARTITION BY thread_id ORDER BY rowid),prompt,status,created_at,updated_at FROM tasks;
      CREATE TRIGGER create_turn_after_task AFTER INSERT ON tasks BEGIN
        INSERT INTO thread_turns(id,thread_id,turn_index,user_content,status,created_at,updated_at)
        VALUES(NEW.id,NEW.thread_id,(SELECT coalesce(max(turn_index),0)+1 FROM thread_turns WHERE thread_id=NEW.thread_id),
          NEW.prompt,NEW.status,NEW.created_at,NEW.updated_at);
      END;
      CREATE TRIGGER turn_artifact_added AFTER INSERT ON artifacts WHEN NEW.turn_id IS NOT NULL BEGIN
        UPDATE thread_turns SET artifacts_summary_json=NULL WHERE id=NEW.turn_id;
      END;
      CREATE TRIGGER turn_artifact_changed AFTER UPDATE OF size_bytes ON artifacts WHEN NEW.turn_id IS NOT NULL BEGIN
        UPDATE thread_turns SET artifacts_summary_json=NULL WHERE id=NEW.turn_id;
      END;
      CREATE TRIGGER turn_artifact_removed AFTER DELETE ON artifacts WHEN OLD.turn_id IS NOT NULL BEGIN
        UPDATE thread_turns SET artifacts_summary_json=NULL WHERE id=OLD.turn_id;
      END;
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE usage_logs ADD COLUMN priced_currency TEXT;
      ALTER TABLE models ADD COLUMN confirmed_free INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE workspaces ADD COLUMN verify_commands_json TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE workspaces ADD COLUMN auto_verify_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspaces ADD COLUMN verify_network_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workspaces ADD COLUMN verify_external_pending INTEGER NOT NULL DEFAULT 0;
      UPDATE workspaces SET verify_external_pending=1 WHERE id IN (SELECT workspace_id FROM tasks WHERE api_key_id IS NOT NULL OR guest_link_id IS NOT NULL);
      ALTER TABLE workspaces ADD COLUMN max_self_heal_retries INTEGER NOT NULL DEFAULT 2 CHECK(max_self_heal_retries BETWEEN 0 AND 5);
      ALTER TABLE workspaces ADD COLUMN review_model_alias TEXT;
      ALTER TABLE threads ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'execute' CHECK(execution_mode IN ('plan','execute'));
      ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
      ALTER TABLE threads ADD COLUMN handoff_doc TEXT;
      ALTER TABLE threads ADD COLUMN plan_turn_id TEXT;
      ALTER TABLE tasks ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'execute';
      ALTER TABLE tasks ADD COLUMN verify_root_id TEXT;
      ALTER TABLE tasks ADD COLUMN verify_only INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN verify_attempt INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN plan_source_id TEXT;
      ALTER TABLE tasks ADD COLUMN review_feedback_hash TEXT;
      CREATE UNIQUE INDEX tasks_plan_source ON tasks(plan_source_id) WHERE plan_source_id IS NOT NULL;
      CREATE TABLE code_reviews (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        turn_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        reviewer_model_alias TEXT NOT NULL, diff_hash TEXT NOT NULL, summary TEXT NOT NULL,
        findings_json TEXT NOT NULL, truncated INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
      );
      CREATE INDEX reviews_by_thread ON code_reviews(thread_id,created_at);
      CREATE TABLE workspace_secrets (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        key_name TEXT NOT NULL, value_enc TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        inject_on_verify INTEGER NOT NULL DEFAULT 0, inject_on_deploy INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(workspace_id,key_name)
      );
    `,
  },
  {version:11,sql:shareMigrationSql+searchMigrationSql+`
    CREATE INDEX IF NOT EXISTS artifacts_hub_time ON artifacts(created_at,id);
    CREATE INDEX IF NOT EXISTS artifacts_hub_workspace ON artifacts(workspace_id,created_at,id);
  `},
  {version:12,sql:gatewayMigrationSql},
  {version:13,sql:modulesMigrationSql},
];

export function runMigrations(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
  )`);
  for (const migration of migrations) {
    database.transaction(() => {
      if (database.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(migration.version)) return;
      database.exec(migration.sql);
      database.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }).immediate();
  }
}
