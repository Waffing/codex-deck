import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
  analyticsQuerySchema, budgetSchema, type AnalyticsQuery, type AnalyticsReport,
  type BudgetAlert, type UsageBudget,
} from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import type { Notifications } from "../notifications/index.js";

const bucket = {
  day: "date(u.created_at)",
  week: "date(u.created_at, '-6 days', 'weekday 1')",
  month: "substr(u.created_at,1,7)",
};
const metrics = `
  count(*) requests, coalesce(sum(1-u.usage_known),0) unknown_usage,
  coalesce(sum(u.input_tokens),0) input_tokens, coalesce(sum(u.output_tokens),0) output_tokens,
  sum(u.cached_input_tokens) cached_input_tokens,
  1.0 * sum(u.cached_input_tokens) / nullif(sum(CASE WHEN u.cached_input_tokens IS NOT NULL THEN u.input_tokens END),0) cache_hit_rate,
  avg(u.tokens_per_sec) tokens_per_sec, avg(u.ttft_ms) ttft_ms,
  coalesce(sum(u.cost_usd),0) cost_usd, coalesce(sum(u.cost_cny),0) cost_cny`;

function report(db: Database.Database, query: AnalyticsQuery): AnalyticsReport {
  const period = bucket[query.period];
  const dimensions = {
    period: [period, period],
    provider: ["coalesce(u.provider_id,'')", "coalesce(p.name,u.provider_id,'—')"],
    model: ["coalesce(u.model_id,u.requested_alias)", "coalesce(m.alias,u.requested_alias)"],
    workspace: ["coalesce(u.workspace_id,'')", "coalesce(w.name,u.workspace_id,'—')"],
    task: ["coalesce(u.task_id,'')", "coalesce(u.task_id,'—')"],
  };
  function grouped(group: AnalyticsQuery["group_by"]) {
    const [id,label] = dimensions[group];
    return db.prepare(`SELECT ${id} id, ${label} label, ${metrics} FROM usage_logs u
      LEFT JOIN providers p ON p.id=u.provider_id LEFT JOIN models m ON m.id=u.model_id
      LEFT JOIN workspaces w ON w.id=u.workspace_id GROUP BY ${id}
      ORDER BY ${group === "period" ? "label" : "requests DESC, label"}`).all() as AnalyticsReport["rows"];
  }
  const trend = grouped("period");
  const totals = db.prepare(`SELECT ${metrics} FROM usage_logs u`).get() as AnalyticsReport["totals"];
  return {trend, totals, rows: query.group_by === "period" ? trend : grouped(query.group_by)};
}

const initialBudget: UsageBudget = {daily_usd:null, monthly_usd:null, daily_cny:null, monthly_cny:null};
function readBudget(db: Database.Database): UsageBudget {
  const value = db.prepare("SELECT value FROM settings WHERE key='usage.budget'").pluck().get();
  return typeof value === "string" ? budgetSchema.parse(JSON.parse(value)) : initialBudget;
}

// Each row contains the most recent alert for one currency and period length.
function checkBudget(db: Database.Database, now: string): BudgetAlert[] {
  const budget = readBudget(db);
  const alerts: BudgetAlert[] = [];
  for (const kind of Object.keys(budget) as (keyof UsageBudget)[]) {
    const limit = budget[kind];
    if (limit === null) continue;
    const period = now.slice(0, kind.startsWith("daily") ? 10 : 7);
    const key = `usage.alert.${kind}`;
    const prior = db.prepare("SELECT value FROM settings WHERE key=?").pluck().get(key);
    if (typeof prior === "string" && JSON.parse(prior).period === period) continue;
    const currency = kind.endsWith("usd") ? "cost_usd" : "cost_cny";
    const spent = Number(db.prepare(`SELECT total(${currency}) FROM usage_logs WHERE created_at>=? AND created_at<=?`).pluck().get(period,now));
    if (spent < limit) continue;
    const alert = {kind, period, spent, limit, created_at:now};
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)").run(key,JSON.stringify(alert),now);
    alerts.push(alert);
  }
  return alerts;
}

function csvCell(value: string|number|null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const safe = /^[\t\r\n]|^\s*[=+@-]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"','""') + '"';
}

export function registerUsageRoutes(app: FastifyInstance, ctx: ServerContext, notifications: Notifications) {
  const auth = {preHandler:createRequireAdmin(ctx)};
  const db = ctx.native;
  const check = db.transaction((now:string) => checkBudget(db,now));
  ctx.onUsageRecorded = () => {
    for (const alert of check.immediate(new Date().toISOString())) void notifications.send("budget_threshold",alert);
  };
  ctx.onUsageRecorded();
  for (const format of ["analytics","export.csv"] as const) {
    app.get("/api/usage/"+format,auth,async (req,reply) => {
      const parsed = analyticsQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({error:"Invalid analytics dimensions."});
      const data = report(db,parsed.data);
      if (format === "analytics") return data;
      const columns: (keyof AnalyticsReport["rows"][number])[] = ["id","label","requests","unknown_usage","input_tokens","output_tokens","cached_input_tokens","cache_hit_rate","ttft_ms","tokens_per_sec","cost_usd","cost_cny"];
      const rows = data.rows.map(row => columns.map(col => csvCell(typeof row[col] === "string" ? ctx.masker.maskString(String(row[col])) : row[col])).join(","));
      return reply.type("text/csv; charset=utf-8").header("Content-Disposition",'attachment; filename="codexdeck-usage.csv"')
        .send("\ufeff"+[columns.join(","),...rows].join("\r\n")+"\r\n");
    });
  }
  app.get("/api/usage/budget",auth,async () => {
    const rows = db.prepare("SELECT value FROM settings WHERE key LIKE 'usage.alert.%' ORDER BY updated_at DESC").all() as {value:string}[];
    return {budget:readBudget(db),alerts:rows.map(row=>JSON.parse(row.value) as BudgetAlert)};
  });
  app.put("/api/usage/budget",auth,async (req,reply) => {
    const input = budgetSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({error:"Budget limits must be positive amounts or null."});
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('usage.budget',?,?)")
      .run(JSON.stringify(input.data),new Date().toISOString());
    ctx.onUsageRecorded?.();
    return input.data;
  });
}
