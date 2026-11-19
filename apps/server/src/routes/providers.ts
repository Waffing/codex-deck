import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import {
  modelCreateSchema, modelPatchSchema, modelSchema,
  providerCreateSchema, providerPatchSchema, providerSchema,
} from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { models, providers } from "../db/schema.js";
import { encryptSecret } from "../security/crypto.js";
import { maskApiKeySuffix } from "../security/secret-masker.js";
import { sealHeaders } from "../gateway/credentials.js";
import { providerPresets } from "../gateway/presets.js";
import { probeProvider } from "../gateway/probe.js";

function providerDto(row: typeof providers.$inferSelect) {
  return providerSchema.parse({
    id: row.id, name: row.name, preset: row.preset, base_url: row.baseUrl,
    api_key_masked: row.apiKeyMasked,
    headers: Object.fromEntries(Object.keys(JSON.parse(row.headersJson)).map(name => [name, "[REDACTED]"])),
    quirks: JSON.parse(row.quirksJson), last_probe: row.lastProbeJson ? JSON.parse(row.lastProbeJson) : null,
    enabled: row.enabled, created_at: row.createdAt, updated_at: row.updatedAt,
  });
}

function modelDto(row: typeof models.$inferSelect) {
  return modelSchema.parse({
    pricing_currency:row.pricingCurrency,cost_input_cny_per_million:row.costInputCnyPerMillion,
    cost_output_cny_per_million:row.costOutputCnyPerMillion,
    id: row.id, alias: row.alias, provider_id: row.providerId, model_id: row.modelId,
    protocol: row.protocol, fallback_model_ids: JSON.parse(row.fallbackModelIdsJson),
    cost_input_usd_per_million: row.costInputUsdPerMillion, cost_output_usd_per_million: row.costOutputUsdPerMillion,
    enabled: row.enabled, created_at: row.createdAt, updated_at: row.updatedAt,
  });
}

type ById = { Params: { id: string } };

export function registerProviderRoutes(app: FastifyInstance, context: ServerContext): void {
  const db = context.orm;
  const auth = { preHandler: createRequireAdmin(context) };
  const getProvider = (id: string) => db.select().from(providers).where(eq(providers.id, id)).get();
  const getModel = (id: string) => db.select().from(models).where(eq(models.id, id)).get();
  app.get("/api/providers/presets", auth, async () => Object.values(providerPresets));
  app.get("/api/providers", auth, async () => db.select().from(providers).orderBy(asc(providers.createdAt)).all().map(providerDto));
  app.get<ById>("/api/providers/:id", auth, async (request, reply) => {
    const provider = getProvider(request.params.id);
    return provider ? providerDto(provider) : reply.code(404).send({ error: "Provider not found." });
  });

  function keyFields(key: string) {
    context.masker.register(key);
    return { apiKeyCiphertext: key ? encryptSecret(key, context.masterKey) : null, apiKeyMasked: maskApiKeySuffix(key) };
  }

  app.post("/api/providers", auth, async (request, reply) => {
    const parsed = providerCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid provider." });
    const p = parsed.data;
    const now = new Date().toISOString();
    const row = db.insert(providers).values({
      id: randomUUID(), name: p.name, preset: p.preset, baseUrl: p.base_url, ...keyFields(p.api_key),
      headersJson: sealHeaders(p.headers, context), quirksJson: JSON.stringify(p.quirks),
      enabled: p.enabled, createdAt: now, updatedAt: now,
    }).returning().get();
    return reply.code(201).send(providerDto(row));
  });
  app.patch<ById>("/api/providers/:id", auth, async (request, reply) => {
    const parsed = providerPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid provider update." });
    const p = parsed.data;
    const row = db.update(providers).set({
      name: p.name, preset: p.preset, baseUrl: p.base_url, enabled: p.enabled,
      ...(p.api_key === undefined ? {} : keyFields(p.api_key)),
      headersJson: p.headers && sealHeaders(p.headers, context),
      quirksJson: p.quirks && JSON.stringify(p.quirks),
      lastProbeJson: p.base_url || p.headers || p.api_key !== undefined ? null : undefined,
      updatedAt: new Date().toISOString(),
    }).where(eq(providers.id, request.params.id)).returning().get();
    return row ? providerDto(row) : reply.code(404).send({ error: "Provider not found." });
  });
  app.delete<ById>("/api/providers/:id", auth, async (request, reply) => {
    const result = db.delete(providers).where(eq(providers.id, request.params.id)).run();
    return result.changes ? reply.code(204).send() : reply.code(404).send({ error: "Provider not found." });
  });

  app.post<ById>("/api/providers/:id/probe", auth, async (request, reply) => {
    const p = getProvider(request.params.id);
    if (!p) return reply.code(404).send({ error: "Provider not found." });
    const model = db.select().from(models).where(eq(models.providerId, p.id)).all().find(m => m.enabled);
    const bound = app.server.address() as AddressInfo | null;
    const result = await probeProvider(p, model?.modelId, context, bound?.port);
    db.update(providers).set({ lastProbeJson: JSON.stringify(result) })
      .where(and(eq(providers.id, p.id), eq(providers.updatedAt, p.updatedAt))).run();
    return result;
  });

  app.get("/api/models", auth, async () => db.select().from(models).orderBy(asc(models.createdAt)).all().map(modelDto));
  app.get<ById>("/api/models/:id", auth, async (request, reply) => {
    const model = getModel(request.params.id);
    return model ? modelDto(model) : reply.code(404).send({ error: "Model not found." });
  });

  function validFallbacks(ids: string[] | undefined, self?: string) {
    return !ids || (new Set(ids).size === ids.length && ids.every(id => id !== self && !!getModel(id)));
  }

  app.post("/api/models", auth, async (request, reply) => {
    const parsed = modelCreateSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid model." });
    const m = parsed.data;
    if (!getProvider(m.provider_id) || !validFallbacks(m.fallback_model_ids)) return reply.code(400).send({ error: "Unknown provider or invalid fallback." });
    if (db.select().from(models).where(eq(models.alias, m.alias)).get()) return reply.code(409).send({ error: "Duplicate model alias." });
    const now = new Date().toISOString();
    const row = db.insert(models).values({
      pricingCurrency:m.pricing_currency,costInputCnyPerMillion:m.cost_input_cny_per_million,costOutputCnyPerMillion:m.cost_output_cny_per_million,
      id: randomUUID(), providerId: m.provider_id, modelId: m.model_id, alias: m.alias, protocol: m.protocol,
      fallbackModelIdsJson: JSON.stringify(m.fallback_model_ids), costInputUsdPerMillion: m.cost_input_usd_per_million,
      costOutputUsdPerMillion: m.cost_output_usd_per_million, enabled: m.enabled, createdAt: now, updatedAt: now,
    }).returning().get();
    return reply.code(201).send(modelDto(row));
  });
  app.patch<ById>("/api/models/:id", auth, async (request, reply) => {
    const parsed = modelPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid model update." });
    const m = parsed.data;
    const id = request.params.id;
    if (!getModel(id)) return reply.code(404).send({ error: "Model not found." });
    if ((m.provider_id && !getProvider(m.provider_id)) || !validFallbacks(m.fallback_model_ids, id)) return reply.code(400).send({ error: "Unknown provider or invalid fallback." });
    const existing = m.alias && db.select().from(models).where(eq(models.alias, m.alias)).get();
    if (existing && existing.id !== id) return reply.code(409).send({ error: "Duplicate model alias." });
    const row = db.update(models).set({
      pricingCurrency:m.pricing_currency,costInputCnyPerMillion:m.cost_input_cny_per_million,costOutputCnyPerMillion:m.cost_output_cny_per_million,
      providerId: m.provider_id, modelId: m.model_id, alias: m.alias, protocol: m.protocol,
      fallbackModelIdsJson: m.fallback_model_ids && JSON.stringify(m.fallback_model_ids),
      costInputUsdPerMillion: m.cost_input_usd_per_million, costOutputUsdPerMillion: m.cost_output_usd_per_million,
      enabled: m.enabled, updatedAt: new Date().toISOString(),
    }).where(eq(models.id, id)).returning().get();
    return modelDto(row);
  });
  app.delete<ById>("/api/models/:id", auth, async (request, reply) => {
    const result = db.delete(models).where(eq(models.id, request.params.id)).run();
    return result.changes ? reply.code(204).send() : reply.code(404).send({ error: "Model not found." });
  });
}
