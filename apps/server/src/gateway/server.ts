import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq } from "drizzle-orm";
import { responseRequestSchema, type ResponseRequest } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { models, providers, usageLogs } from "../db/schema.js";
import { verifyInternalToken, verifySignedPayload } from "../security/crypto.js";
import { withProviderKey } from "./credentials.js";
import { estimateUsageCost, OutputTiming } from "./metrics.js";
import { fromChatResponse, toChatRequest, translateChatStream } from "./transforms.js";
import { readSse, type SseFrame } from "./sse.js";
import { redactSse } from "./redact-sse.js";
import { upstreamHeaders, upstreamUrl } from "./upstream.js";
import { upstreamFetch } from "./transport.js";
import type { AddressInfo } from "node:net";
import {recordGuestUsage,taskLink} from "../temp-access/service.js";

type Channel = { model: typeof models.$inferSelect; provider: typeof providers.$inferSelect };
type Meter = { channel: Channel | null; attempted: string[]; input: number; cached:number|null; timing:OutputTiming; output: number; known:boolean; status: number; error: string | null };

class GatewayError extends Error {
  constructor(readonly status: number, message: string, readonly retryable = false) { super(message); }
}

function findChannel(context: ServerContext, field: "id" | "alias", value: string): Channel | undefined {
  return context.orm.select({ model: models, provider: providers }).from(models)
    .innerJoin(providers, eq(models.providerId, providers.id))
    .where(and(eq(models[field], value), eq(models.enabled, true), eq(providers.enabled, true))).get();
}

function registerUsage(reply: FastifyReply, alias: string, context: ServerContext, threadId?:string, taskId?:string) {
  const owner=threadId && context.native.prepare("SELECT workspace_id FROM threads WHERE id=?").pluck().get(threadId);
  const meter: Meter = { channel: null, attempted: [], input: 0, cached:null, timing:new OutputTiming(), output: 0, status: 200, error: null, known:false };
  const start = performance.now();
  const persist = () => {
    const model = meter.channel?.model;
    const cost=estimateUsageCost(model,meter.input,meter.output,meter.cached);
    context.native.transaction(()=>{
    context.orm.insert(usageLogs).values({
      id: randomUUID(), modelId: model?.id, providerId: model?.providerId, requestedAlias: context.masker.maskString(alias),
      inputTokens: meter.input, outputTokens: meter.output,...cost,
      usageKnown:meter.known,threadId,taskId,workspaceId:typeof owner==="string"?owner:null,
      turnId:taskId,cachedInputTokens:meter.cached,ttftMs:meter.timing.ttft,tokensPerSec:meter.timing.speed(meter.output),
      latencyMs: Math.round(performance.now() - start), statusCode: reply.raw.writableFinished ? meter.status : 499,
      failoverFrom: meter.attempted.length > 1 ? meter.attempted.slice(0, -1).join(",") : null,
      error: meter.error, createdAt: new Date().toISOString(),
    }).run();
    recordGuestUsage(context,taskId,meter.input+meter.output,cost,!meter.known && !!meter.channel && meter.status===200);
    })();
    context.onUsageRecorded?.();
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
  const usage = response.usage as { input_tokens?: number; output_tokens?: number; input_tokens_details?:{cached_tokens?:number} } | null;
  if (!usage) return;
  meter.known=Number.isSafeInteger(usage.input_tokens) && usage.input_tokens!>=0 && Number.isSafeInteger(usage.output_tokens) && usage.output_tokens!>=0;
  if (Number.isSafeInteger(usage.input_tokens) && usage.input_tokens! >= 0) meter.input = usage.input_tokens!;
  if (Number.isSafeInteger(usage.output_tokens) && usage.output_tokens! >= 0) meter.output = usage.output_tokens!;
  const cached=usage.input_tokens_details?.cached_tokens;
  if(typeof cached==="number" && Number.isSafeInteger(cached) && cached>=0 && cached<=meter.input) meter.cached=cached;
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
  const caps = model.lastProbeJson ? JSON.parse(model.lastProbeJson).capabilities : null;
  const quirks = JSON.parse(provider.quirksJson);
  let chat = quirks.force_chat === true || model.protocol === "chat" || (model.protocol === "auto" && !caps?.responses && !!caps?.chat);
  const stripReasoning = quirks.strip_reasoning === true;
  const abort = new AbortController();
  const onClose = () => abort.abort();
  reply.raw.once("close", onClose);
  const timeout = setTimeout(() => abort.abort(new Error("timeout")), context.gatewayConfig.upstream_timeout_ms);
  try {
    const capped={...request,max_output_tokens:Math.min(typeof request.max_output_tokens==="number"?request.max_output_tokens:model.maxOutputTokens,model.maxOutputTokens)};
    const call = (useChat: boolean,apiKey:string,headers:Record<string,string>) => {
      const body = useChat ? toChatRequest(capped, model.modelId) : { ...capped, model: model.modelId };
      if (stripReasoning) {
        delete body.reasoning;
        delete body.reasoning_effort;
      }
      return upstreamFetch(upstreamUrl(provider.baseUrl, useChat ? "chat/completions" : "responses"), {
        method: "POST", headers: upstreamHeaders(headers, apiKey), body: JSON.stringify(body), signal: abort.signal,
      },!!apiKey || Object.values(headers).some(Boolean),[context.gatewayConfig.port,(reply.server.server.address() as AddressInfo|null)?.port]);
    };
    const response = await withProviderKey(provider,context,async(apiKey,headers)=>{
      const first=await call(chat,apiKey,headers);
      if(chat || model.protocol!=="auto" || ![404,405].includes(first.status)) return first;
      await first.body?.cancel();
      chat=true;
      return call(true,apiKey,headers);
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new GatewayError(response.ok ? 502 : response.status, `Upstream returned HTTP ${response.status}.`, [401,429].includes(response.status) || response.status >= 500);
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
    const observed=redactSse(frames,context.masker,event=>{
      if (["response.output_text.delta","response.function_call_arguments.delta"].includes(String(event.type))) meter.timing.delta(event.delta);
    });
    for await (const { raw, event } of observed) {
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
  const claimsByRequest=new WeakMap<object,Record<string,unknown>>();
  app.post("/internal/v1/responses", {
    onRequest: async (request, reply) => {
      const ip = request.raw.socket.remoteAddress ?? "";
      const loopback = ip === "::1" || /^(::ffff:)?127\./i.test(ip);
      const credential = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
      const token=credential?.startsWith("cdlease_") ? context.resolveSessionLease?.(credential,"model") : credential;
      const claims=token && verifyInternalToken(token,context.masterKey) ? verifySignedPayload(token,context.masterKey):null;
      if (!loopback || !claims || (claims.task_id!==undefined && (typeof claims.task_id!=="string" || typeof claims.thread_id!=="string" ||
          !context.native.prepare("SELECT 1 FROM tasks WHERE id=? AND thread_id=? AND status='running'").get(claims.task_id,claims.thread_id)))) {
        await reply.code(401).send({ error: "A valid local gateway token is required." });
      } else claimsByRequest.set(request,claims);
    },
  }, async (request, reply) => {
    const parsed = responseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid Responses request." });
    const input = parsed.data;
    const claims = claimsByRequest.get(request);
    if (typeof claims?.thread_id === "string") {
      const thread = context.native.prepare("SELECT active_model_alias,reasoning_effort FROM threads WHERE id=?")
        .get(claims.thread_id) as {active_model_alias: string | null; reasoning_effort: string | null} | undefined;
      if (!thread?.active_model_alias) return reply.code(403).send({error: "Thread unavailable."});
      input.model = claims.purpose==="compaction" && typeof claims.model_alias==="string" ? claims.model_alias : thread.active_model_alias;
      if (thread.reasoning_effort && claims.purpose!=="compaction") input.reasoning = { ...input.reasoning as object, effort: thread.reasoning_effort };
    }
    const taskId=typeof claims?.task_id==="string"?claims.task_id:undefined;
    const guest=taskLink(context,taskId);
    if(guest && guest.status!=="active") return reply.code(403).send({error:"Guest quota or access expired."});
    // Preflight a finite budget before contacting a paid upstream. UTF-8 bytes conservatively reserve input
    // across supported tokenizers, including tool descriptions, image payloads and message framing.
    const inputReserve=guest && (guest.max_tokens!=null || guest.max_cost!=null)
      ? Buffer.byteLength(JSON.stringify([input.instructions,input.tools,input.input]))+128 : 0;
    const meter = registerUsage(reply, input.model, context,typeof claims?.thread_id==="string"?claims.thread_id:undefined,taskId);
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
      let maxOutput=input.max_output_tokens ?? channel.model.maxOutputTokens;
      if(guest?.max_tokens!=null)maxOutput=Math.min(maxOutput,guest.max_tokens-guest.used_tokens-inputReserve);
      if(guest?.max_cost!=null){
        const m=channel.model,cny=guest.currency==="CNY";
        if(guest.currency!==m.pricingCurrency){
          failure=new GatewayError(403,"The guest budget currency does not match this model.");continue;
        }
        const inputRate=Math.max(cny?m.costInputCnyPerMillion:m.costInputUsdPerMillion,m.cacheReadPricePer1m);
        const outputRate=cny?m.costOutputCnyPerMillion:m.costOutputUsdPerMillion;
        const left=(guest.max_cost-guest.used_cost)*1_000_000-inputReserve*inputRate;
        if(left<0)maxOutput=0;
        else if(outputRate>0)maxOutput=Math.min(maxOutput,Math.floor(left/outputRate));
      }
      if(maxOutput<1){
        failure=new GatewayError(403,"Remaining guest budget cannot cover this request. Shorten the input or extend the quota.");continue;
      }
      meter.channel = channel;
      meter.attempted.push(id);
      try {
        return await forward(context, reply, channel, guest?{...input,max_output_tokens:maxOutput}:input, meter);
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
