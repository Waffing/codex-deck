export interface SseFrame {
  raw: string;
  data: string;
  event?: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let buffer = "";
  let raw = "";
  let dataLines: string[] = [];
  let event: string | undefined;
  let firstLine = true;
  let finished = false;

  const parseLine = (line: string): void => {
    if (line === "") return;
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "event") {
      event = value;
    }
  };

  const takeFrame = (): SseFrame => {
    const frame: SseFrame = { raw, data: dataLines.join("\n") };
    if (event !== undefined) frame.event = event;
    raw = "";
    dataLines = [];
    event = undefined;
    return frame;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      finished = done;
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });

      while (buffer.length > 0) {
        const ending = /\r\n|\r|\n/.exec(buffer);
        if (!ending) break;
        const endIndex = ending.index + ending[0].length;
        if (ending[0] === "\r" && endIndex === buffer.length && !done) break;
        const rawLine = buffer.slice(0, endIndex);
        const content = buffer.slice(0, ending.index);
        const line = firstLine ? content.replace(/^\uFEFF/, "") : content;
        firstLine = false;
        buffer = buffer.slice(endIndex);
        raw += rawLine;

        if (line === "") {
          yield takeFrame();
        } else {
          parseLine(line);
        }
      }

      if (done) break;
    }

    if (buffer.length > 0) {
      raw += buffer;
      parseLine(buffer);
    }
    if (raw) yield takeFrame();
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}
