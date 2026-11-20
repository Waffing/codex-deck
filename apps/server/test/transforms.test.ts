import { describe, expect, it } from "vitest";
import { readSse } from "../src/gateway/sse.js";
import { fromChatResponse, toChatRequest, translateChatStream } from "../src/gateway/transforms.js";

const encoder = new TextEncoder();

function bytes(text: string, splitAt = 0): ReadableStream<Uint8Array> {
  const data = encoder.encode(text);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < data.length; i += splitAt || data.length) {
        controller.enqueue(data.subarray(i, i + (splitAt || data.length)));
      }
      controller.close();
    },
  });
}

function chatFrame(delta: unknown, finish_reason: string | null = null) {
  return "data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + "\r\n\r\n";
}

function eventData(frame: string) {
  return JSON.parse(frame.split("\ndata: ")[1].trim());
}

describe("SSE framing", () => {
  it("keeps raw comments, multi-line fields, BOM, UTF-8, and mixed line endings intact", async () => {
    const raw = "\uFEFF: hé\r\n\r\nevent: update\rdata: 你好\rdata: again\r\r: ping\n\nid: 2\ndata: tail";
    const frames = [];
    for await (const frame of readSse(bytes(raw, 1))) frames.push(frame);
    expect(frames.map((frame) => frame.raw).join("")).toBe(raw);
    expect(frames.map((frame) => frame.data)).toEqual(["", "你好\nagain", "", "tail"]);
    expect(frames[1].event).toBe("update");
  });

  it("cancels the unread upstream when a consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode("data: first\n\n")); },
      cancel() { cancelled = true; },
    });
    for await (const frame of readSse(body)) {
      expect(frame.data).toBe("first");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("Responses and Chat payloads", () => {
  it("preserves multimodal history, parallel assistant calls, tool outputs and forced tool choice", () => {
    const tool = { type: "function", name: "lookup", parameters: { type: "object" }, strict: true };
    const result = toChatRequest({
      model: "alias", instructions: "concise", stream: true, tools: [tool],
      tool_choice: { type: "function", name: "lookup" }, max_output_tokens: 42,
      input: [
        { role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" }] },
        { role: "assistant", content: "Checking" },
        { type: "function_call", call_id: "a", name: "lookup", arguments: '{"id":1}' },
        { type: "function_call", call_id: "b", name: "lookup", arguments: '{"id":2}' },
        { type: "function_call_output", call_id: "b", output: "second" },
        { type: "function_call_output", call_id: "a", output: "first" },
      ],
    }, "real");
    expect(result).toEqual({
      model: "real", stream: true, stream_options: { include_usage: true }, max_completion_tokens: 42,
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" }, strict: true } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
      messages: [
        { role: "system", content: "concise" },
        { role: "user", content: [{ type: "text", text: "inspect" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "low" } }] },
        { role: "assistant", content: "Checking", tool_calls: [
          { type: "function", id: "a", function: { name: "lookup", arguments: '{"id":1}' } },
          { type: "function", id: "b", function: { name: "lookup", arguments: '{"id":2}' } },
        ] },
        { role: "tool", tool_call_id: "b", content: "second" },
        { role: "tool", tool_call_id: "a", content: "first" },
      ],
    });
  });

  it("assembles non-stream function calls and usage including cached and reasoning tokens", () => {
    expect(fromChatResponse({
      choices: [{ finish_reason: "tool_calls", message: { content: "Searching", tool_calls: [
        { id: "call_a", function: { name: "query", arguments: '{"q":"hi"}' } },
      ] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 1 } },
    }, "alias")).toMatchObject({
      model: "alias", status: "completed", output: [
        { type: "message", content: [{ type: "output_text", text: "Searching" }] },
        { type: "function_call", status: "completed", call_id: "call_a", name: "query", arguments: '{"q":"hi"}' },
      ],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
    });
  });

  it("reports truncated completions and rejects an error-shaped successful HTTP response", () => {
    expect(fromChatResponse({ choices: [{ message: { content: "truncated" }, finish_reason: "length" }] }, "alias"))
      .toMatchObject({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ status: "incomplete" }] });
    expect(() => fromChatResponse({ error: { message: "secret" } }, "alias")).toThrow("invalid Chat completion");
  });
});

describe("progressive Chat chunks", () => {
  it("streams text before closure and retains interleaved argument deltas at stable output indexes", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; } });
    const stream = translateChatStream(body, "alias");
    upstream.enqueue(encoder.encode(chatFrame({ content: "你" })));
    const events: ReturnType<typeof eventData>[] = [];
    while (!events.some((event) => event.type === "response.output_text.delta")) {
      const next = await stream.next();
      expect(next.done).toBe(false);
      events.push(eventData(next.value!));
    }
    const callDelta = (index: number, fields: object, fn: object) => ({ index, ...fields, function: fn });
    const chunk = chatFrame({ tool_calls: [
      callDelta(0, { id: "first" }, { name: "wea", arguments: "" }),
      callDelta(1, { id: "second" }, { name: "time", arguments: '{"tz":' }),
    ] }) + chatFrame({ tool_calls: [
      callDelta(1, {}, { arguments: '"UTC"}' }),
      callDelta(0, {}, { name: "ther", arguments: '{"city":' }),
    ] }) + chatFrame({ content: "好", tool_calls: [callDelta(0, {}, { arguments: '"北京"}' })] }, "tool_calls")
      + 'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":8}}\n\ndata: [DONE]\n\n';
    for (const b of encoder.encode(chunk)) upstream.enqueue(Uint8Array.of(b));
    upstream.close();
    for await (const frame of stream) events.push(eventData(frame));
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.filter((e) => e.type === "response.output_item.added").map((e) => e.output_index)).toEqual([0, 1, 2]);
    expect(events[0].type).toBe("response.created");
    expect(events.at(-1)).toMatchObject({ type: "response.completed", response: {
      output: [
        { type: "message", content: [{ type: "output_text", text: "你好" }] },
        { type: "function_call", call_id: "first", name: "weather", arguments: '{"city":"北京"}' },
        { type: "function_call", call_id: "second", name: "time", arguments: '{"tz":"UTC"}' },
      ], usage: { total_tokens: 21 },
    } });
    for (const index of [1, 2]) {
      const added = events.find((e) => e.type === "response.output_item.added" && e.output_index === index).item;
      const done = events.find((e) => e.type === "response.output_item.done" && e.output_index === index).item;
      const fragments = events.filter((e) => e.type === "response.function_call_arguments.delta" && e.item_id === added.id);
      expect(done.id).toBe(added.id);
      expect(fragments.map((e) => e.delta).join("")).toBe(done.arguments);
    }
  });

  it("withholds creation until valid input and detects an interrupted stream", async () => {
    await expect(translateChatStream(bytes("data: {bad}\n\n"), "alias").next()).rejects.toThrow("invalid Chat SSE");
    const stream = translateChatStream(bytes(chatFrame({ content: "partial" })), "alias");
    const types: string[] = [];
    await expect(async () => {
      for await (const frame of stream) types.push(eventData(frame).type);
    }).rejects.toThrow("ended before completion");
    expect(types).toContain("response.output_text.delta");
    expect(types).not.toContain("response.completed");
  });

  it("emits a genuine incomplete terminal event on content filtering", async () => {
    const events = [];
    for await (const frame of translateChatStream(bytes(chatFrame({ refusal: "filtered" }, "content_filter")), "alias")) {
      events.push(eventData(frame));
    }
    expect(events.some((event) => event.type === "response.refusal.delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "content_filter" } },
    });
  });
});
it("enforces the per-event SSE buffer limit before dispatch and preserves complete neighboring frames",async()=>{
  let cancelled=false;
  const body=new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: a\n\ndata: b\r"));
      controller.enqueue(encoder.encode("\n\r\n"));
      controller.enqueue(encoder.encode("data: incomplete"));
    },
    cancel(){cancelled=true;},
  });
  const frames=readSse(body,12);
  expect((await frames.next()).value?.data).toBe("a");
  expect((await frames.next()).value?.data).toBe("b");
  await expect(frames.next()).rejects.toThrow(/size limit/);
  expect(cancelled).toBe(true);
});
