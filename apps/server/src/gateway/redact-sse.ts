import type { SecretMasker } from "../security/secret-masker.js";
import type { SseFrame } from "./sse.js";

type Event = Record<string, unknown>;
type Buffered = { frame: SseFrame; event?: Event; ready: boolean; rewritten?: boolean };
type Group = { text: string; parts: Buffered[] };

// A key echoed in several deltas must be redacted before any of those fragments
// reach the client. Hold only frames whose text could still complete a known key.
export async function* redactSse(frames: AsyncIterable<SseFrame>, masker: SecretMasker) {
  const queue: Buffered[] = [];
  const groups = new Map<string, Group>();
  let bytesHeld = 0;

  function resolve(key: string, group: Group) {
    const masked = masker.maskString(group.text);
    group.parts.forEach((part, index) => {
      if (masked !== group.text) {
        part.event!.delta = index === 0 ? masked : "";
        part.rewritten = true;
      }
      part.ready = true;
    });
    groups.delete(key);
  }

  function* drain() {
    while (queue[0]?.ready) {
      const part = queue.shift()!;
      bytesHeld -= part.frame.raw.length;
      const event = part.event;
      const safe = event ? masker.maskObject(event) : undefined;
      let raw = masker.maskString(part.frame.raw);
      if (safe && (part.rewritten || JSON.stringify(safe) !== JSON.stringify(event))) {
        const name = String(safe.type ?? part.frame.event ?? "message").replace(/[\r\n]/g, "");
        raw = `event: ${name}\ndata: ${JSON.stringify(safe)}\n\n`;
      }
      yield { raw, event };
    }
  }

  for await (const frame of frames) {
    const event: Event | undefined = frame.data && frame.data.trim() !== "[DONE]" ? JSON.parse(frame.data) : undefined;
    const part: Buffered = { frame, event, ready: true };
    queue.push(part);
    bytesHeld += frame.raw.length;
    const type = String(event?.type);
    const key = JSON.stringify([type.replace(/\.(delta|done)$/, ""), event?.item_id, event?.output_index, event?.content_index]);
    if (typeof event?.delta === "string") {
      const group = groups.get(key) ?? { text: "", parts: [] };
      group.text += event.delta;
      group.parts.push(part);
      if (masker.endsWithSecretPrefix(group.text)) {
        part.ready = false;
        groups.set(key, group);
      } else resolve(key, group);
    } else if (groups.has(key) && type.endsWith(".done")) {
      resolve(key, groups.get(key)!);
    } else if (["response.completed", "response.incomplete", "response.failed", "error"].includes(type)) {
      for (const [pending, group] of groups) resolve(pending, group);
    }
    yield* drain();
    // Bound memory if an upstream leaves one channel ambiguous while flooding another.
    if (bytesHeld > 2 * 1024 * 1024) throw new Error("Upstream stream buffering limit exceeded.");
  }
  for (const [key, group] of groups) resolve(key, group);
  yield* drain();
}
