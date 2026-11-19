import { probeResultSchema, type ProbeResult } from "@codexdeck/shared";
import type { providers } from "../db/schema.js";
import type { ServerContext } from "../app.js";
import { readCredentials } from "./credentials.js";
import { readSse } from "./sse.js";
import { upstreamHeaders, upstreamUrl } from "./upstream.js";

const redSquare = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC";
type RequestUpstream = (endpoint: string, body?: object) => Promise<Response>;
type Protocol = "responses" | "chat/completions";

async function ttft(request: RequestUpstream, protocol: Protocol, model: string) {
  const start = performance.now();
  const content = protocol === "responses"
    ? { input: "Reply OK.", max_output_tokens: 64 }
    : { messages: [{ role: "user", content: "Reply OK." }], max_tokens: 64 };
  const response = await request(protocol, { model, stream: true, ...content });
  try {
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return null;
    for await (const frame of readSse(response.body)) {
      if (!frame.data || frame.data === "[DONE]") continue;
      const chunk = JSON.parse(frame.data);
      const delta = protocol === "responses"
        ? chunk.type === "response.output_text.delta" && chunk.delta
        : chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta.length) return Math.round(performance.now() - start);
    }
    return null;
  } finally {
    await response.body?.cancel();
  }
}

async function capability(request: RequestUpstream, protocol: Protocol, model: string, feature: "tools" | "vision") {
  const tool = { name: "ping", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const imagePrompt = "Which color fills the image? Answer one English color name.";
  const native = protocol === "responses";
  let input;
  if (feature === "tools") {
    input = native
      ? { input: "Call ping.", tools: [{ type: "function", ...tool }], tool_choice: { type: "function", name: tool.name } }
      : { messages: [{ role: "user", content: "Call ping." }], tools: [{ type: "function", function: tool }],
        tool_choice: { type: "function", function: { name: tool.name } } };
  } else {
    input = native ? { input: [{ role: "user", content: [{ type: "input_text", text: imagePrompt },
      { type: "input_image", image_url: redSquare }] }] }
      : { messages: [{ role: "user", content: [{ type: "text", text: imagePrompt }, { type: "image_url", image_url: { url: redSquare } }] }] };
  }
  const response = await request(protocol, { model, ...input, ...native ? { max_output_tokens: 64 } : { max_tokens: 64 } });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const result = await response.json();
  if (feature === "tools") return native
    ? result.output?.some((i: {type: string; name?: string}) => i.type === "function_call" && i.name === "ping") === true
    : result.choices?.[0]?.message?.tool_calls?.some((i: {function?: {name?: string}}) => i.function?.name === "ping") === true;
  const answer = native ? result.output?.flatMap((i: {content?: {text?: string}[]}) => i.content?.map(c => c.text) ?? []).join(" ")
    : result.choices?.[0]?.message?.content;
  return typeof answer === "string" && /\bred\b/i.test(answer);
}

export async function probeProvider(provider: typeof providers.$inferSelect, configuredModel: string | undefined,
  context: ServerContext, boundPort?: number): Promise<ProbeResult> {
  const result: ProbeResult = { provider_id: provider.id, ok: false, models: [],
    checked_at: new Date().toISOString(), capabilities: { responses: false, chat: false, tools: false, vision: false, latency_ms: null } };
  const base = upstreamUrl(provider.baseUrl, "models");
  const port = Number(base.port || (base.protocol === "https:" ? 443 : 80));
  if ([22, 80, 443, context.gatewayConfig.port, boundPort].includes(port)) {
    return { ...result, error: "Probe target uses a protected port." };
  }
  const { apiKey, headers } = readCredentials(provider, context);
  const request: RequestUpstream = (endpoint, body) => fetch(upstreamUrl(provider.baseUrl, endpoint), {
    method: body ? "POST" : "GET", headers: upstreamHeaders(headers, apiKey), redirect: "error",
    body: body && JSON.stringify(body), signal: AbortSignal.timeout(Math.min(context.gatewayConfig.upstream_timeout_ms, 8000)),
  });
  const list = await request("models").catch(() => undefined);
  if (list?.ok) {
    const json = await list.json().catch(() => undefined);
    if (Array.isArray(json?.data)) result.models = json.data.flatMap((item: { id?: unknown } | null) => typeof item?.id === "string" ? [item.id] : []);
  } else await list?.body?.cancel();

  const model = configuredModel ?? result.models[0] ?? "gpt-4o-mini";
  const [responses, chat] = await Promise.all((["responses", "chat/completions"] as const)
    .map(protocol => ttft(request, protocol, model).catch(() => null)));
  const caps = result.capabilities;
  caps.responses = responses !== null;
  caps.chat = chat !== null;
  caps.latency_ms = responses ?? chat;
  result.ok = caps.responses || caps.chat;
  if (result.ok) {
    const protocol = caps.responses ? "responses" : "chat/completions";
    [caps.tools, caps.vision] = await Promise.all((["tools", "vision"] as const)
      .map(feature => capability(request, protocol, model, feature).catch(() => false)));
  } else result.error = "No supported streaming protocol responded with a text delta.";
  return probeResultSchema.parse(context.masker.maskObject(result));
}
