import { createHash, randomUUID } from "node:crypto";
import type { ResponseRequest } from "@codexdeck/shared";
import { readSse } from "./sse.js";

type JsonObject = Record<string, unknown>;
type Status = "in_progress" | "completed" | "incomplete";

function record(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function invalidInput(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function inputContent(content: unknown): string | JsonObject[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return invalidInput("Message content must contain text or content parts.");
  return content.map((value) => {
    const part = record(value);
    if (["input_text", "output_text", "text"].includes(String(part.type)) && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (part.type === "input_image" && typeof part.image_url === "string") {
      return { type: "image_url", image_url: { url: part.image_url, detail: part.detail ?? "auto" } };
    }
    if (part.type === "refusal" && typeof part.refusal === "string") return { type: "refusal", refusal: part.refusal };
    return invalidInput("Unsupported Chat message content part.");
  });
}

function inputTool(tool: JsonObject): JsonObject {
  if (tool.type !== "function" || typeof tool.name !== "string") {
    return invalidInput("Chat translation requires named function tools.");
  }
  const { type, ...definition } = tool;
  return { type, function: definition };
}

// Chat accepts flat function names of at most 64 characters. Keep the binding
// deterministic across turns, even if the model's tool list changes order.
function chatToolName(name:string, namespace:unknown) {
  if (typeof namespace !== "string" || !namespace) return name;
  const hash=createHash("sha256").update(JSON.stringify([namespace,name])).digest("hex").slice(0,20);
  return `ns_${hash}_${name.replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,40)}`;
}
function chatTools(tools: JsonObject[] = []) {
  const names = new Map<string,{name:string;namespace?:string}>();
  const declarations:JsonObject[]=[];
  function add(tool:JsonObject,namespace?:string) {
    if(typeof tool.name!=="string") return invalidInput("A named tool is required.");
    const name=chatToolName(tool.name,namespace);
    if(names.has(name)) return invalidInput("Duplicate Chat tool name.");
    names.set(name,namespace?{name:tool.name,namespace}:{name:tool.name});
    const {namespace: _namespace, ...definition}=tool;
    declarations.push(inputTool({...definition,name}));
  }
  for(const tool of tools) {
    if(tool.type==="function") add(tool,typeof tool.namespace==="string"?tool.namespace:undefined);
    else if(tool.type!=="namespace") add(tool);
    else {
      if(typeof tool.name!=="string" || !tool.name || !Array.isArray(tool.tools)) return invalidInput("Invalid tool namespace.");
      for(const child of tool.tools) add(record(child),tool.name);
    }
  }
  return {names,declarations};
}

export function toChatRequest(request: ResponseRequest, modelId: string): JsonObject {
  if (request.previous_response_id || request.conversation) {
    return invalidInput("Chat translation requires the full input history.");
  }
  const messages: JsonObject[] = [];
  if (request.instructions) messages.push({ role: "system", content: request.instructions });
  if (typeof request.input === "string") messages.push({ role: "user", content: request.input });
  else {
    for (const item of request.input) {
      // Chat carries conversation history explicitly and has no reasoning-item representation.
      if (item.type === "reasoning") continue;
      if (item.type === "function_call") {
        if (typeof item.name !== "string" || typeof item.call_id !== "string" || typeof item.arguments !== "string") {
          return invalidInput("A function call requires name, call_id and JSON arguments.");
        }
        let assistant = messages.at(-1);
        if (assistant?.role !== "assistant") {
          assistant = { role: "assistant", content: null };
          messages.push(assistant);
        }
        const calls: JsonObject[] = (assistant.tool_calls ??= []) as JsonObject[];
        calls.push({ type: "function", id: item.call_id, function: { name: chatToolName(item.name,item.namespace), arguments: item.arguments } });
      } else if (item.type === "function_call_output") {
        if (typeof item.call_id !== "string") return invalidInput("Tool output requires a call_id.");
        const content = inputContent(item.output);
        if (Array.isArray(content) && content.some((part) => part.type !== "text")) {
          return invalidInput("Chat tool results support text content only.");
        }
        messages.push({ role: "tool", tool_call_id: item.call_id, content });
      } else if ((item.type === undefined || item.type === "message")
        && ["user", "assistant", "system", "developer"].includes(String(item.role))) {
        messages.push({ role: item.role, content: inputContent(item.content) });
      } else {
        return invalidInput("Unsupported Responses input item for Chat translation.");
      }
    }
  }

  const result: JsonObject = { model: modelId, messages, stream: request.stream };
  for (const key of ["temperature", "top_p", "parallel_tool_calls", "metadata", "service_tier", "user"]) {
    if (request[key] !== undefined) result[key] = request[key];
  }
  if (request.max_output_tokens !== undefined) result.max_completion_tokens = request.max_output_tokens;
  const effort = record(request.reasoning).effort;
  if (effort) result.reasoning_effort = effort;
  const format = record(record(request.text).format);
  if (format.type === "json_schema") {
    const { type, ...json_schema } = format;
    result.response_format = { type, json_schema };
  } else if (format.type) result.response_format = format;
  if (request.tools) result.tools = chatTools(request.tools).declarations;
  if (typeof request.tool_choice === "string") result.tool_choice = request.tool_choice;
  else if (request.tool_choice) {
    const {namespace,name,...choice}=request.tool_choice;
    result.tool_choice = inputTool({...choice,name:typeof name==="string"?chatToolName(name,namespace):name});
  }
  if (request.stream) result.stream_options = { include_usage: true };
  return result;
}

function chatUsage(source: unknown): JsonObject | null {
  if (!source) return null;
  const usage = record(source);
  const input = usage.prompt_tokens, output = usage.completion_tokens;
  if (typeof input!=="number" || typeof output!=="number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input<0 || output<0) return null;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: record(usage.prompt_tokens_details).cached_tokens ?? usage.prompt_cache_hit_tokens },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: record(usage.completion_tokens_details).reasoning_tokens ?? 0 },
    total_tokens: usage.total_tokens ?? input + output,
  };
}

function incompleteReason(finishReason: unknown): string | null {
  if (finishReason === "length") return "max_output_tokens";
  return finishReason === "content_filter" ? "content_filter" : null;
}

function envelope(alias: string, request?: ResponseRequest) {
  return {
    id: "resp_" + randomUUID(), object: "response", model: alias, created_at: Math.floor(Date.now() / 1000),
    instructions: request?.instructions ?? null, metadata: request?.metadata ?? {}, error: null,
    parallel_tool_calls: request?.parallel_tool_calls ?? true, tools: request?.tools ?? [],
    tool_choice: request?.tool_choice ?? "auto", temperature: request?.temperature ?? null, top_p: request?.top_p ?? null,
    incomplete_details: null, status: "in_progress" as Status, output: [] as JsonObject[], usage: null,
  };
}

export function fromChatResponse(chat: unknown, alias: string, request?: ResponseRequest): JsonObject {
  const source = record(chat);
  const choice = record(Array.isArray(source.choices) ? source.choices[0] : undefined);
  const message = record(choice.message);
  if (source.error || !("content" in message || "tool_calls" in message || "refusal" in message)) {
    throw new Error("Upstream returned an invalid Chat completion.");
  }
  const reason = incompleteReason(choice.finish_reason);
  const status = reason ? "incomplete" : "completed";
  const response = envelope(alias, request);
  const content: JsonObject[] = [];
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const {names}=chatTools(request?.tools);
  if (typeof message.content === "string" && (message.content || (!toolCalls.length && !message.refusal))) {
    content.push({ type: "output_text", text: message.content, annotations: [] });
  }
  if (typeof message.refusal === "string" && message.refusal) content.push({ type: "refusal", refusal: message.refusal });
  if (content.length) {
    response.output.push({ id: "msg_" + randomUUID(), type: "message", role: "assistant", status, content });
  }
  for (const rawCall of toolCalls) {
    const call = record(rawCall);
    const fn = record(call.function);
    if (typeof call.id !== "string" || typeof fn.name !== "string" || typeof fn.arguments !== "string") {
      throw new Error("Upstream returned an invalid function call.");
    }
    response.output.push({
      id: "fc_" + randomUUID(), type: "function_call", call_id: call.id, ...(names.get(fn.name) ?? {name:fn.name}), arguments: fn.arguments, status,
    });
  }
  return {
    ...response, created_at: source.created ?? response.created_at, status,
    incomplete_details: reason ? { reason } : null, usage: chatUsage(source.usage),
  };
}

interface StreamCall {
  item: { id: string; type: "function_call"; status: Status; call_id: string; name: string; namespace?:string; arguments: string };
  outputIndex: number;
  announced: boolean;
}

export async function* translateChatStream(
  body: ReadableStream<Uint8Array>, alias: string, request?: ResponseRequest,
): AsyncGenerator<string> {
  const response = envelope(alias, request);
  let sequence = 0;
  const event = (type: string, payload: JsonObject): string =>
    "event: " + type + "\ndata: " + JSON.stringify({ type, sequence_number: sequence++, ...payload }) + "\n\n";

  const calls = new Map<number, StreamCall>();
  const {names}=chatTools(request?.tools);
  const parts = new Map<string, { index: number; value: string }>();
  let message: { id: string; role: string; type: string; content: JsonObject[]; status: Status } | undefined;
  let messageIndex = -1;
  let usage: JsonObject | null = null;
  let finishReason: string | undefined;
  let started = false;
  let sawDone = false;
  for await (const frame of readSse(body)) {
    if (!frame.data) continue;
    if (frame.data.trim() === "[DONE]") {
      sawDone = true;
      break;
    }
    let chunk: JsonObject;
    try {
      chunk = record(JSON.parse(frame.data));
    } catch {
      throw new Error("Upstream sent an invalid Chat SSE record.");
    }
    if (chunk.error || !Array.isArray(chunk.choices)) throw new Error("Upstream rejected the Chat stream.");
    if (!started) {
      started = true;
      yield event("response.created", { response });
      yield event("response.in_progress", { response });
    }
    if (chunk.usage) usage = chatUsage(chunk.usage);
    const choice = record(chunk.choices[0]);
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = record(choice.delta);
    for (const key of ["content", "refusal"]) {
      const fragment = delta[key];
      if (typeof fragment !== "string" || !fragment) continue;
      if (!message) {
        messageIndex = response.output.length;
        message = { id: "msg_" + randomUUID(), type: "message", role: "assistant", content: [], status: "in_progress" };
        response.output.push(message);
        yield event("response.output_item.added", { output_index: messageIndex, item: message });
      }
      let part = parts.get(key);
      const type = key === "content" ? "output_text" : "refusal";
      if (!part) {
        part = { index: parts.size, value: "" };
        parts.set(key, part);
        const initial = type === "output_text" ? { type, annotations: [], text: "" } : { type, refusal: "" };
        message.content.push(initial);
        yield event("response.content_part.added", {
          output_index: messageIndex, item_id: message.id, content_index: part.index, part: initial,
        });
      }
      part.value += fragment;
      yield event("response." + type + ".delta", {
        output_index: messageIndex, item_id: message.id, content_index: part.index,
        delta: fragment, ...(type === "output_text" ? { logprobs: [] } : {}),
      });
    }

    for (const rawCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const incoming = record(rawCall);
      const index = incoming.index ?? 0;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new Error("Invalid tool index.");
      let call = calls.get(index);
      if (!call) {
        const item: StreamCall["item"] = {
          id: "fc_" + randomUUID(), type: "function_call", status: "in_progress", call_id: "", name: "", arguments: "",
        };
        call = { item, outputIndex: -1, announced: false };
        calls.set(index, call);
      }
      const fn = record(incoming.function);
      if (typeof incoming.id === "string") call.item.call_id = incoming.id;
      if (typeof fn.name === "string") call.item.name += fn.name;
      const fragment = typeof fn.arguments === "string" ? fn.arguments : "";
      // SDK accumulators append output items in announcement order.
      if (!call.announced && call.item.call_id && call.item.name && (names.size===0 || names.has(call.item.name))) {
        Object.assign(call.item,names.get(call.item.name));
        call.announced = true;
        call.outputIndex = response.output.length;
        response.output.push(call.item);
        yield event("response.output_item.added", { output_index: call.outputIndex, item: { ...call.item, arguments: "" } });
        if (call.item.arguments) yield event("response.function_call_arguments.delta", {
          output_index: call.outputIndex, item_id: call.item.id, delta: call.item.arguments,
        });
      }
      call.item.arguments += fragment;
      if (call.announced && fragment) yield event("response.function_call_arguments.delta", {
        output_index: call.outputIndex, item_id: call.item.id, delta: fragment,
      });
    }
  }

  if (!started || (!finishReason && !sawDone)) throw new Error("The Chat stream ended before completion.");
  const reason = incompleteReason(finishReason);
  const status = reason ? "incomplete" : "completed";
  if (message) {
    for (const [key, part] of parts) {
      const type = key === "content" ? "output_text" : "refusal";
      const locations = { item_id: message.id, output_index: messageIndex, content_index: part.index };
      const done = type === "output_text" ? { text: part.value, logprobs: [] } : { refusal: part.value };
      const finalPart = type === "output_text" ? { type, text: part.value, annotations: [] } : { type, refusal: part.value };
      message.content[part.index] = finalPart;
      yield event("response." + type + ".done", { ...locations, ...done });
      yield event("response.content_part.done", { ...locations, part: finalPart });
    }
    message.status = status;
    yield event("response.output_item.done", { output_index: messageIndex, item: message });
  }
  for (const { item, outputIndex, announced } of calls.values()) {
    if (!announced) throw new Error("Incomplete upstream tool metadata.");
    item.status = status;
    yield event("response.function_call_arguments.done", {
      output_index: outputIndex, item_id: item.id, name: item.name, arguments: item.arguments,
    });
    yield event("response.output_item.done", { output_index: outputIndex, item });
  }
  yield event("response." + status, { response: { ...response, status, incomplete_details: reason ? { reason } : null, usage } });
}

