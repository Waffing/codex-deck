export const gatewayMigrationSql=`
ALTER TABLE providers ADD COLUMN protocol_type TEXT;
ALTER TABLE providers ADD COLUMN patch_rules_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE providers ADD COLUMN circuit_breaker_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE providers ADD COLUMN weight INTEGER NOT NULL DEFAULT 100;
ALTER TABLE providers ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN daily_budget REAL NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN monthly_budget REAL NOT NULL DEFAULT 0;
ALTER TABLE providers ADD COLUMN budget_action TEXT NOT NULL DEFAULT 'alert';
ALTER TABLE api_keys ADD COLUMN allowed_models_json TEXT NOT NULL DEFAULT '["*"]';
ALTER TABLE api_keys ADD COLUMN tpm_limit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN daily_budget REAL NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN monthly_budget REAL NOT NULL DEFAULT 0;
CREATE TABLE routing_profiles(id TEXT PRIMARY KEY,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,description TEXT NOT NULL,
 strategy TEXT NOT NULL,targets_json TEXT NOT NULL,active_target_index INTEGER NOT NULL,is_global_default INTEGER NOT NULL,
 enabled INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX routing_single_default ON routing_profiles(is_global_default) WHERE is_global_default=1;
CREATE TABLE gateway_request_logs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,source_type TEXT NOT NULL,api_key_id TEXT,
 thread_id TEXT,virtual_model TEXT NOT NULL,provider_id TEXT,actual_model TEXT,inbound_protocol TEXT NOT NULL,outbound_protocol TEXT,
 failover_chain_json TEXT NOT NULL,status_code INTEGER NOT NULL,error_summary TEXT,ttft_ms REAL,total_ms REAL,tokens_per_sec REAL,
 input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_tokens INTEGER,cost_estimate REAL NOT NULL,currency TEXT,
 debug_payload_enc TEXT,created_at TEXT NOT NULL);
CREATE INDEX gateway_logs_time ON gateway_request_logs(created_at DESC,id);
CREATE INDEX gateway_logs_provider ON gateway_request_logs(provider_id,created_at DESC);
CREATE INDEX gateway_logs_key ON gateway_request_logs(api_key_id,created_at DESC);
CREATE TABLE gateway_provider_attempts(id INTEGER PRIMARY KEY,provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,status_code INTEGER NOT NULL);
CREATE INDEX gateway_attempts_recent ON gateway_provider_attempts(provider_id,id DESC);
CREATE TABLE gateway_budget_usage(day TEXT NOT NULL,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,currency TEXT NOT NULL,
 amount REAL NOT NULL,PRIMARY KEY(owner_type,owner_id,currency,day));
`;
