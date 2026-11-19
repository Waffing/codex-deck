import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { responseRequestSchema, type ResponseRequest } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { models, providers, usageLogs } from "../db/schema.js";
import { verifyInternalToken, verifySignedPayload } from "../security/crypto.js";
import { readCredentials } from "./credentials.js";
import { fromChatResponse, toChatRequest, translateChatStream } from "./transforms.js";
import { readSse, type SseFrame } from "./sse.js";
import { redactSse } from "./redact-sse.js";
import { upstreamHeaders, upstreamUrl } from "./upstream.js";

type Channel = { model: typeof models.$inferSelect; provider: typeof providers.$inferSelect };
type Meter = { channel: Channel | null; attempted: string[]; input: number; output: number; status: number; error: string | null };

class GatewayError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

function findChannel(context: ServerContext, field: "id" | "alias", value: string): Channel | undefined {
  return context.orm.select({ model: models, provider: providers }).from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models[field], value), eq(models.enabled, true), eq(providers.enabled, true))).get();
}

function registerUsage(reply: FastifyReply, alias: string, context: ServerContext): Meter {
  const meter: Meter = { channel: null, attempted: [], input: 0, output: 0, status: 200, error: null };
  const start = performance.now();
  const persist = () => {
    const model = meter.channel?.model;
    const cny = model?.pricingCurrency === "CNY";
    const inputRate = cny ? model.costInputCnyPerMillion : model?.costInputUsdPerMillion ?? 0;
    const outputRate = cny ? model.costOutputCnyPerMillion : model?.costOutputUsdPerMillion ?? 0;
    const cost = (meter.input * inputRate + meter.output * outputRate) / 1_000_000;
    context.orm.insert(usageLogs).values({
      id: randomUUID(), modelId: model?.id, providerId: model?.providerId, requestedAlias: context.masker.maskString(alias),
      inputTokens: meter.input, outputTokens: meter.output, costUsd: cny ? 0 : cost, costCny: cny ? cost : 0,
      latencyMs: Math.round(performance.now() - start), statusCode: reply.raw.writableFinished ? meter.status : 499,
      failoverFrom: meter.attempted.length > 1 ? meter.attempted.slice(0, -1).join(",") : null,
      error: meter.error, createdAt: new Date().toISOString(),
    }).run();
  };
  const afterResponse = () => {
    reply.raw.removeListener("finish", afterResponse);
    reply.raw.removeListener("close", afterResponse);
    queueMicrotask(() => {
      try {
        persist();
      } catch {
        console.error("CodexDeck could not persist a gateway usage record.");
      }
    });
  };
  reply.raw.once("finish", afterResponse);
  reply.raw.once("close", afterResponse);
  return meter;
}

function readUsage(response: Record<string, unknown>, meter: Meter) {
  const usage = response.usage as { input_tokens?: number; output_tokens?: number } | null;
  if (!usage) return;
  if (Number.isSafeInteger(usage.input_tokens) && usage.input_tokens! >= 0) meter.input = usage.input_tokens!;
  if (Number.isSafeInteger(usage.output_tokens) && usage.output_tokens! >= 0) meter.output = usage.output_tokens!;
}

async function* streamFrames(body: ReadableStream<Uint8Array>, chat: boolean, request: ResponseRequest): AsyncGenerator<SseFrame> {
  if (!chat) {
    yield* readSse(body);
    return;
  }
  for await (const raw of translateChatStream(body, request.model, request)) {
    const data = raw.split("\n").find((line) => line.startsWith("data: "))!.slice(6);
    yield { raw, data };
  }
}

function setFailoverHeader(reply: FastifyReply, meter: Meter) {
  if (meter.attempted.length > 1) reply.header("X-CodexDeck-Failover", meter.attempted.map(encodeURIComponent).join(","));
}

async function forward(context: ServerContext, reply: FastifyReply, channel: Channel, request: ResponseRequest, meter: Meter) {
  const { model, provider } = channel;
  const { headers, apiKey } = readCredentials(provider, context);
  const caps = provider.lastProbeJson ? JSON.parse(provider.lastProbeJson).capabilities : null;
  const quirks = JSON.parse(provider.quirksJson);
  let chat = quirks.force_chat === true || model.protocol === "chat" || (model.protocol === "auto" && !caps?.responses && !!caps?.chat);
  const stripReasoning = quirks.strip_reasoning === true;
  const abort = new AbortController();
  const onClose = () => abort.abort();
  reply.raw.once("close", onClose);
  const timeout = setTimeout(() => abort.abort(new Error("timeout")), context.gatewayConfig.upstream_timeout_ms);
  try {
    const call = (useChat: boolean) => {
      const body = useChat ? toChatRequest(request, model.modelId) : { ...request, model: model.modelId };
      if (stripReasoning) {
        delete body.reasoning;
        delete body.reasoning_effort;
      }
      return fetch(upstreamUrl(provider.baseUrl, useChat ? "chat/completions" : "responses"), {
        method: "POST", redirect: "error", headers: upstreamHeaders(headers, apiKey), body: JSON.stringify(body), signal: abort.signal,
      });
    };
    let response = await call(chat);
    if (!chat && model.protocol === "auto" && [404, 405].includes(response.status)) {
      await response.body?.cancel();
      chat = true;
      response = await call(true);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new GatewayError(response.ok ? 502 : response.status, `Upstream returned HTTP ${response.status}.`, response.status === 429 || response.status >= 500);
    }

    if (!request.stream) {
      const data = await response.json();
      const result = chat ? fromChatResponse(data, request.model, request) : data;
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new GatewayError(502, "Invalid upstream response.");
      readUsage(result, meter);
      setFailoverHeader(reply, meter);
      return reply.send(context.masker.maskObject(result));
    }

    let terminal = false;
    const frames = streamFrames(response.body, chat, request);
    for await (const { raw, event } of redactSse(frames, context.masker)) {
      if (event) {
        if (event.response && typeof event.response === "object") readUsage(event.response as Record<string, unknown>, meter);
        if (["response.completed", "response.incomplete", "response.failed", "error"].includes(String(event.type))) terminal = true;
        if (event.type === "response.failed" || event.type === "error") {
          meter.status = 502;
          meter.error = "Upstream stream reported failure.";
        }
      }
      if (!reply.raw.headersSent) {
        setFailoverHeader(reply, meter);
        reply.type("text/event-stream; charset=utf-8").header("cache-control", "no-cache");
        reply.hijack();
        for (const [name, value] of Object.entries(reply.getHeaders())) {
          if (value !== undefined) reply.raw.setHeader(name, value);
        }
        reply.raw.writeHead(200);
      }
      if (!reply.raw.write(raw)) await once(reply.raw, "drain", { signal: abort.signal });
      timeout.refresh();
    }
    if (!terminal) throw new GatewayError(502, "Upstream stream ended before a terminal event.");
    reply.raw.end();
  } catch (error) {
    if (abort.signal.aborted && !reply.raw.destroyed) throw new GatewayError(504, "Upstream timed out.", true);
    if (error instanceof TypeError && error.cause) throw new GatewayError(502, "Upstream connection failed.", true);
    if (error instanceof GatewayError) throw error;
    if (error instanceof Error && "statusCode" in error && error.statusCode === 400) throw new GatewayError(400, error.message);
    throw new GatewayError(502, "Invalid upstream response.");
  } finally {
    clearTimeout(timeout);
    reply.raw.removeListener("close", onClose);
    abort.abort();
  }
}

export function registerGatewayRoutes(app: FastifyInstance, context: ServerContext): void {
  app.post("/internal/v1/responses", {
    onRequest: async (request, reply) => {
      const ip = request.raw.socket.remoteAddress ?? "";
      const loopback = ip === "::1" || /^(::ffff:)?127\./i.test(ip);
      const token = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
      if (!loopback || !token || !verifyInternalToken(token, context.masterKey)) {
        await reply.code(401).send({ error: "A valid local gateway token is required." });
      }
    },
  }, async (request, reply) => {
    const parsed = responseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Responses request." });
    const input = parsed.data;
    const token = request.headers.authorization!.slice(7);
    const claims = verifySignedPayload(token, context.masterKey);
    if (typeof claims?.thread_id === "string") {
      const thread = context.native.prepare("SELECT active_model_alias,reasoning_effort FROM threads WHERE id=?")
        .get(claims.thread_id) as {active_model_alias: string | null; reasoning_effort: string | null} | undefined;
      if (!thread?.active_model_alias) return reply.code(403).send({error: "Thread unavailable."});
      input.model = thread.active_model_alias;
      if (thread.reasoning_effort) input.reasoning = { ...input.reasoning as object, effort: thread.reasoning_effort };
    }
    const meter = registerUsage(reply, input.model, context);
    const primary = findChannel(context, "alias", input.model);
    if (!primary) {
      meter.status = 404;
      meter.error = "Unknown or disabled model.";
      return reply.code(meter.status).send({ error: meter.error });
    }
    const ids = new Set<string>([primary.model.id, ...JSON.parse(primary.model.fallbackModelIdsJson)]);
    let failure = new GatewayError(502, "No available model.");
    for (const id of ids) {
      const channel = id === primary.model.id ? primary : findChannel(context, "id", id);
      if (!channel) continue;
      meter.channel = channel;
      meter.attempted.push(id);
      try {
        return await forward(context, reply, channel, input, meter);
      } catch (error) {
        failure = error instanceof GatewayError ? error : new GatewayError(500, "Gateway configuration failed.");
        if (reply.raw.headersSent || reply.raw.destroyed || !failure.retryable) break;
      }
    }
    meter.status = failure.status;
    meter.error = context.masker.maskString(failure.message);
    if (reply.raw.destroyed) return;
    if (reply.raw.headersSent) {
      const event = { type: "error", code: "upstream_error", message: meter.error, param: null };
      reply.raw.end(`event: error\ndata: ${JSON.stringify(event)}\n\n`);
      return;
    }
    setFailoverHeader(reply, meter);
    return reply.code(failure.status).send({ error: meter.error });
  });
}
