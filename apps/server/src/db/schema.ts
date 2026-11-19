import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const providers = sqliteTable("providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  preset: text("preset").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyCiphertext: text("api_key_ciphertext"),
  apiKeyMasked: text("api_key_masked"),
  headersJson: text("headers_json").notNull(),
  quirksJson: text("quirks_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  lastProbeJson: text("last_probe_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const models = sqliteTable("models", {
  pricingCurrency: text("pricing_currency").notNull().default("USD"),
  costInputCnyPerMillion: real("cost_input_cny_per_million").notNull().default(0),
  costOutputCnyPerMillion: real("cost_output_cny_per_million").notNull().default(0),
  id: text("id").primaryKey(),
  providerId: text("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  alias: text("alias").notNull().unique(),
  modelId: text("model_id").notNull(),
  protocol: text("protocol").notNull(),
  fallbackModelIdsJson: text("fallback_model_ids_json").notNull(),
  costInputUsdPerMillion: real("cost_input_usd_per_million").notNull(),
  costOutputUsdPerMillion: real("cost_output_usd_per_million").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaces = sqliteTable("workspaces", {
  automationLevel: text("automation_level").notNull().default("conservative"),
  status: text("status").notNull().default("ready"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const threads = sqliteTable("threads", {
  activeModelAlias: text("active_model_alias"),
  reasoningEffort: text("reasoning_effort"),
  sessionRulesJson: text("session_rules_json").notNull().default("[]"),
  remoteThreadId: text("remote_thread_id"),
  codexHome: text("codex_home"),
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const threadEvents = sqliteTable("thread_events", {
  taskId: text("task_id"),
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  type: text("type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
});

export const approvals = sqliteTable("approvals", {
  expiresAt: text("expires_at"),
  riskLevel: text("risk_level").notNull().default("high"),
  id: text("id").primaryKey(),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  payloadJson: text("payload_json").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
});

export const artifacts = sqliteTable("artifacts", {
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  turnId: text("turn_id"),
  changeType: text("change_type").notNull().default("modified"),
  id: text("id").primaryKey(),
  threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  mimeType: text("mime_type"),
  createdAt: text("created_at").notNull(),
});

export const deployments = sqliteTable("deployments", {
  lastVerificationJson: text("last_verification_json"),
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  configJson: text("config_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const apiKeys = sqliteTable("api_keys", {
  prefix: text("prefix").notNull().default(""),
  workspaceIdsJson: text("workspace_ids_json").notNull().default("[]"),
  rateLimitRpm: integer("rate_limit_rpm").notNull().default(60),
  webhookOriginsJson: text("webhook_origins_json").notNull().default("[]"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  scopesJson: text("scopes_json").notNull(),
  createdAt: text("created_at").notNull(),
  revokedAt: text("revoked_at"),
});

export const usageLogs = sqliteTable("usage_logs", {
  costCny: real("cost_cny").notNull().default(0),
  id: text("id").primaryKey(),
  modelId: text("model_id"),
  providerId: text("provider_id"),
  requestedAlias: text("requested_alias").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsd: real("cost_usd").notNull(),
  latencyMs: integer("latency_ms"),
  statusCode: integer("status_code"),
  failoverFrom: text("failover_from"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export const notificationChannels = sqliteTable("notification_channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  configJson: text("config_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  status: text("status").notNull().default("queued"),
  summary: text("summary").notNull().default(""),
  apiKeyId: text("api_key_id").references(() => apiKeys.id),
  webhookUrl: text("webhook_url"),
  webhookState: text("webhook_state"),
  webhookAttempts: integer("webhook_attempts").notNull().default(0),
  webhookNextAt: integer("webhook_next_at").notNull().default(0),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const checkpoints = sqliteTable("checkpoints", {
  turnId: text("turn_id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  createdAt: text("created_at").notNull(),
});

export const schema = {
  tasks,
  checkpoints,
  settings,
  providers,
  models,
  workspaces,
  threads,
  threadEvents,
  approvals,
  artifacts,
  deployments,
  apiKeys,
  usageLogs,
  notificationChannels,
};
