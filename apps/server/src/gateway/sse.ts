export interface SseFrame {
  raw: string;
  data: string;
  event?: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>, maxFrameChars=2*1024*1024): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  let buffer = "";
  let raw = "";
  let dataLines: string[] = [];
  let event: string | undefined;
  let firstLine = true;
  let finished = false;
  const lineEnd=/\r\n|\r|\n/g;
  let scanFrom=0;
  function checkSize(chars:number) {
    if(chars>maxFrameChars) throw new Error("Upstream SSE frame exceeds its size limit.");
  }

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
        lineEnd.lastIndex=scanFrom;
        const ending = lineEnd.exec(buffer);
        if (!ending) {scanFrom=buffer.length;break;}
        const endIndex = ending.index + ending[0].length;
        if (ending[0] === "\r" && endIndex === buffer.length && !done) {scanFrom=ending.index;break;}
        checkSize(raw.length+endIndex);
        const rawLine = buffer.slice(0, endIndex);
        const content = buffer.slice(0, ending.index);
        const line = firstLine ? content.replace(/^\uFEFF/, "") : content;
        firstLine = false;
        buffer = buffer.slice(endIndex);
        scanFrom=0;
        raw += rawLine;

        if (line === "") {
          yield takeFrame();
        } else {
          parseLine(line);
        }
      }
      checkSize(raw.length+buffer.length);

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
