import { blob, integer, real, sqliteTable, text, primaryKey, unique, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

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
  apiKeysEnc: text("api_keys_enc"),
  balanceEndpoint: text("balance_endpoint"),
  balanceTokenEnc: text("balance_token_enc"),
  balanceUserId: text("balance_user_id"),
  lastBalanceJson: text("last_balance_json"),
  rotationStrategy: text("rotation_strategy").notNull().default("round_robin"),
  apiKeyMasked: text("api_key_masked"),
  headersJson: text("headers_json").notNull(),
  quirksJson: text("quirks_json").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  lastProbeJson: text("last_probe_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const models = sqliteTable("models", {
  contextWindow: integer("context_window").notNull().default(128000),
  maxOutputTokens: integer("max_output_tokens").notNull().default(16384),
  cacheReadPricePer1m: real("cache_read_price_per_1m").notNull().default(0),
  capabilitiesJson: text("capabilities_json").notNull().default("[]"),
  lastBenchmarkJson: text("last_benchmark_json"),
  lastProbeJson: text("last_probe_json"),
  confirmedFree: integer("confirmed_free", {mode:"boolean"}).notNull().default(false),
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
  verifyCommandsJson: text("verify_commands_json").notNull().default("[]"),
  autoVerifyEnabled: integer("auto_verify_enabled",{mode:"boolean"}).notNull().default(false),
  verifyNetworkEnabled: integer("verify_network_enabled",{mode:"boolean"}).notNull().default(false),
  verifyExternalPending:integer("verify_external_pending",{mode:"boolean"}).notNull().default(false),
  maxSelfHealRetries: integer("max_self_heal_retries").notNull().default(2),
  reviewModelAlias: text("review_model_alias"),
  automationLevel: text("automation_level").notNull().default("conservative"),
  status: text("status").notNull().default("ready"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const threads = sqliteTable("threads", {
  executionMode: text("execution_mode").notNull().default("execute"),
  parentThreadId: text("parent_thread_id").references(():AnySQLiteColumn=>threads.id,{onDelete:"set null"}),
  handoffDoc: text("handoff_doc"),
  planTurnId: text("plan_turn_id"),
  executorMode: text("executor_mode").notNull().default("standard"),
  pinned: integer("pinned", {mode:"boolean"}).notNull().default(false),
  lastContextTokens: integer("last_context_tokens"),
  compactedSummary: text("compacted_summary"),
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
  sizeBytes: integer("size_bytes"),
  contentSha256: text("content_sha256"),
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
  turnId: text("turn_id"),
  cachedInputTokens: integer("cached_input_tokens"),
  ttftMs: integer("ttft_ms"),
  tokensPerSec: real("tokens_per_sec"),
  threadId:text("thread_id"), taskId:text("task_id"), workspaceId:text("workspace_id"),
  usageKnown:integer("usage_known",{mode:"boolean"}).notNull().default(false),
  costCny: real("cost_cny").notNull().default(0),
  id: text("id").primaryKey(),
  modelId: text("model_id"),
  providerId: text("provider_id"),
  requestedAlias: text("requested_alias").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  pricedCurrency: text("priced_currency"),
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

export const tempAccessLinks = sqliteTable("temp_access_links", {
  id:text("id").primaryKey(),name:text("name").notNull(),tokenHash:text("token_hash").notNull().unique(),codeHash:text("code_hash"),
  expiresAt:text("expires_at").notNull(),workspaceIdsJson:text("workspace_ids_json").notNull(),permission:text("permission").notNull(),
  maxTurns:integer("max_turns"),usedTurns:integer("used_turns").notNull().default(0),maxTokens:integer("max_tokens"),
  usedTokens:integer("used_tokens").notNull().default(0),maxCost:real("max_cost"),usedCost:real("used_cost").notNull().default(0),
  currency:text("currency").notNull(),bindFirstIp:integer("bind_first_ip",{mode:"boolean"}).notNull(),boundIp:text("bound_ip"),
  createdAt:text("created_at").notNull(),note:text("note").notNull(),firstVisit:text("first_visit"),status:text("status").notNull().default("active"),
  usageUnconfirmed:integer("usage_unconfirmed",{mode:"boolean"}).notNull().default(false),failedCodes:integer("failed_codes").notNull().default(0),
  retryAfter:integer("retry_after").notNull().default(0),
});
export const guestSessions = sqliteTable("guest_sessions", {
  id:text("id").primaryKey(),tokenHash:text("token_hash").notNull().unique(),
  linkId:text("link_id").notNull().references(()=>tempAccessLinks.id,{onDelete:"cascade"}),ip:text("ip").notNull(),
  lastSeenAt:text("last_seen_at").notNull(),workspaceId:text("workspace_id"),
});
export const tasks = sqliteTable("tasks", {
  executionMode:text("execution_mode").notNull().default("execute"),
  verifyRootId:text("verify_root_id"), verifyAttempt:integer("verify_attempt").notNull().default(0),
  planSourceId:text("plan_source_id").unique(),
  reviewFeedbackHash:text("review_feedback_hash"),
  verifyOnly:integer("verify_only",{mode:"boolean"}).notNull().default(false),
  guestLinkId:text("guest_link_id").references(()=>tempAccessLinks.id),
  answerMarkdown: text("answer_markdown"),
  turnDiffJson: text("turn_diff_json"),
  imageIdsJson:text("image_ids_json").notNull().default("[]"),
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

export const codeReviews = sqliteTable("code_reviews", {
  id:text("id").primaryKey(), threadId:text("thread_id").notNull().references(()=>threads.id,{onDelete:"cascade"}),
  turnId:text("turn_id").references(()=>tasks.id,{onDelete:"cascade"}),
  workspaceId:text("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  reviewerModelAlias:text("reviewer_model_alias").notNull(), diffHash:text("diff_hash").notNull(),
  summary:text("summary").notNull(), findingsJson:text("findings_json").notNull(),
  truncated:integer("truncated",{mode:"boolean"}).notNull().default(false), createdAt:text("created_at").notNull(),
});
export const workspaceSecrets = sqliteTable("workspace_secrets", {
  id:text("id").primaryKey(), workspaceId:text("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  keyName:text("key_name").notNull(), valueEnc:text("value_enc").notNull(), description:text("description").notNull().default(""),
  injectOnVerify:integer("inject_on_verify",{mode:"boolean"}).notNull().default(false),
  injectOnDeploy:integer("inject_on_deploy",{mode:"boolean"}).notNull().default(false),
  createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
}, table=>[unique().on(table.workspaceId,table.keyName)]);

export const threadTurns = sqliteTable("thread_turns", {
  id:text("id").primaryKey().references(()=>tasks.id,{onDelete:"cascade"}),
  threadId:text("thread_id").notNull().references(()=>threads.id,{onDelete:"cascade"}),
  turnIndex:integer("turn_index").notNull(), clientMsgId:text("client_msg_id"), requestHash:text("request_hash"),
  userContent:text("user_content").notNull(), assistantMarkdown:text("assistant_markdown"),
  timelineSummaryJson:text("timeline_summary_json"), artifactsSummaryJson:text("artifacts_summary_json"),
  telemetryJson:text("telemetry_json"), summaryOnly:integer("summary_only",{mode:"boolean"}).notNull().default(false),
  status:text("status").notNull(), latestSeqId:integer("latest_seq_id").notNull().default(0),
  createdAt:text("created_at").notNull(), updatedAt:text("updated_at").notNull(),
});
export const turnAnswerReplay = sqliteTable("turn_answer_replay", {
  turnId:text("turn_id").primaryKey().references(()=>threadTurns.id,{onDelete:"cascade"}),frames:blob("frames").notNull(),
});

export const checkpoints = sqliteTable("checkpoints", {
  turnId: text("turn_id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  threadId: text("thread_id").notNull().references(() => threads.id, { onDelete: "cascade" }),
  ref: text("ref").notNull(),
  createdAt: text("created_at").notNull(),
});

export const taskSubmissions = sqliteTable("task_submissions", {
  apiKeyId:text("api_key_id").notNull().references(()=>apiKeys.id,{onDelete:"cascade"}),
  workspaceId:text("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  requestKey:text("request_key").notNull(), fingerprint:text("fingerprint").notNull(),
  taskId:text("task_id").notNull().references(()=>tasks.id,{onDelete:"cascade"}),
}, table=>[primaryKey({columns:[table.apiKeyId,table.workspaceId,table.requestKey]})]);
export const adminAudit = sqliteTable("admin_audit",{
  id:integer("id").primaryKey(),requestId:text("request_id").notNull(), action:text("action").notNull(),
  target:text("target"),details:text("details").notNull(),status:integer("status").notNull(),createdAt:text("created_at").notNull(),
});
export const userSessions=sqliteTable("user_sessions",{
  sessionId:text("session_id").primaryKey(),tokenHash:text("token_hash").notNull().unique(),ip:text("ip").notNull(),
  userAgent:text("user_agent").notNull(),createdAt:text("created_at").notNull(),lastActiveAt:text("last_active_at").notNull(),
  expiresAt:text("expires_at").notNull(),revoked:integer("revoked",{mode:"boolean"}).notNull().default(false),
});
export const loginBans=sqliteTable("login_bans",{
  ip:text("ip").primaryKey(),failures:integer("failures").notNull(),bannedUntil:integer("banned_until").notNull(),lastAttempt:integer("last_attempt").notNull(),
});
export const auditLogs=sqliteTable("audit_logs",{
  id:integer("id").primaryKey(),event:text("event").notNull(),actor:text("actor").notNull(),ip:text("ip"),
  detailsJson:text("details_json").notNull(),createdAt:text("created_at").notNull(),
});
export const publicShares = sqliteTable("public_shares", {
  id:text("id").primaryKey(), slug:text("slug").notNull().unique(),
  workspaceId:text("workspace_id").notNull().references(()=>workspaces.id,{onDelete:"cascade"}),
  artifactId:text("artifact_id").notNull().references(()=>artifacts.id,{onDelete:"cascade"}),
  relPath:text("rel_path").notNull(), title:text("title").notNull(), shareType:text("share_type").notNull(),
  contentSha256:text("content_sha256").notNull(), sizeBytes:integer("size_bytes").notNull(),
  passcodeHash:text("passcode_hash"), expiresAt:text("expires_at").notNull(), maxViews:integer("max_views"),
  viewCount:integer("view_count").notNull().default(0), allowDownload:integer("allow_download").notNull().default(0),
  status:text("status").notNull().default("active"), createdAt:text("created_at").notNull(),
});
export const publicShareReads = sqliteTable("public_share_reads", {
  sessionId:text("session_id").primaryKey(), shareId:text("share_id").notNull().references(()=>publicShares.id,{onDelete:"cascade"}),
  expiresAt:integer("expires_at").notNull(),
});

export const schema = {
  publicShares,publicShareReads,
  codeReviews,workspaceSecrets,
  tempAccessLinks,guestSessions,
  taskSubmissions,adminAudit,userSessions,loginBans,auditLogs,
  tasks,threadTurns,turnAnswerReplay,
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
