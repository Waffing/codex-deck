import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export type Json = Record<string, unknown>;
export type RpcId = number | string;
export interface RpcCallbacks {
  notify(method: string, params: Json): void;
  request(method: string, params: Json, id: RpcId): void;
  stderr(line: string): void;
  exit(): void;
}

async function command(explicit?: string): Promise<[string, string[]]> {
  const configured = explicit ?? process.env.CODEX_BIN;
  if (configured) {
    const file = await realpath(configured);
    return /\.[cm]?js$/i.test(file) ? [process.execPath, [file, "app-server"]] : [file, ["app-server"]];
  }
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(p => path.isAbsolute(p));
  for (const directory of directories) {
    const candidates = process.platform === "win32"
      ? ["codex.exe", path.join("node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-" + process.arch,
        "vendor", process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc", "bin", "codex.exe")]
      : ["codex"];
    for (const candidate of candidates) {
      const file = path.join(directory, candidate);
      try { await access(file); return [await realpath(file), ["app-server"]]; } catch { /* Try next PATH entry. */ }
    }
  }
  throw new Error("Codex executable unavailable. Configure CODEX_BIN.");
}

export class RpcClient {
  private sequence = 0;
  private closed = false;
  private readonly pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly exited: Promise<void>;

  static async start(cwd: string, env: Record<string,string>, callbacks: RpcCallbacks, binary?: string) {
    const [file, args] = await command(binary);
    return new RpcClient(spawn(file, args, { cwd, env, stdio: "pipe", windowsHide: true }), callbacks);
  }

  private constructor(private readonly proc: ChildProcessWithoutNullStreams, private readonly callbacks: RpcCallbacks) {
    this.exited = new Promise(resolve => proc.once("close", () => { this.end(); resolve(); }));
    proc.once("error", () => this.end());
    proc.stdin.on("error", () => this.end());
    const stdout = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    stdout.on("line", line => {
      try { this.receive(JSON.parse(line)); } catch { this.callbacks.stderr("Invalid app-server protocol frame."); this.proc.kill(); }
    });
    createInterface({ input: proc.stderr, crlfDelay: Infinity }).on("line", line => callbacks.stderr(line));
  }

  private receive(msg: { method?: string; params?: Json; id?: RpcId; result?: Json; error?: unknown }) {
    if (typeof msg.method === "string") {
      if (msg.id !== undefined) this.callbacks.request(msg.method, msg.params ?? {}, msg.id);
      else this.callbacks.notify(msg.method, msg.params ?? {});
    } else if (typeof msg.id === "number") {
      const request = this.pending.get(msg.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(msg.id);
      if (msg.error !== undefined) request.reject(new Error("Codex rejected the RPC request."));
      else request.resolve(msg.result ?? {});
    }
  }

  private send(frame: object) {
    if (this.closed || !this.proc.stdin.writable) throw new Error("Codex process disconnected.");
    this.proc.stdin.write(JSON.stringify(frame) + "\n");
  }

  call(method: string, params: object): Promise<Json> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex RPC timeout: " + method));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ method, params, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params?: object) { this.send({ method, params }); }
  answer(id: RpcId, result: object) { this.send({ id, result }); }
  unsupported(id: RpcId) { this.send({ id, error: { code: -32601, message: "Unsupported app-server request." } }); }
  get pid() { return this.proc.pid ?? null; }
  get alive() { return !this.closed && this.proc.exitCode === null && !this.proc.killed; }

  private end() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer); waiter.reject(new Error("Codex process exited."));
    }
    this.pending.clear();
    this.callbacks.exit();
  }

  async close(force = false) {
    this.proc.stdin.end();
    if (!force && await Promise.race([this.exited.then(() => true), delay(1200, false, { ref: false })])) return;
    if (process.platform === "win32" && this.proc.pid) {
      const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/F", "/T", "/PID", String(this.proc.pid)], { stdio: "ignore", windowsHide: true });
      killer.once("error", () => this.proc.kill());
    } else this.proc.kill("SIGKILL");
    await this.exited;
  }
}
