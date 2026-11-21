const secretPatterns = [
  /\bcdk_live_[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi,
];
function protocolField(key:string,value:unknown) {
  if(typeof value!=="string") return false;
  if (/^(?:id|.*(?:_id|Id))$/.test(key)) return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
  if (key.endsWith("_at") || key==="timestamp") return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value);
  if (key==="version") return /^\d+\.\d+\.\d+$/.test(value);
  if (key==="diff_hash") return /^[0-9a-f]{64}$/.test(value);
  return /^(?:type|status|role|mode|side)$/.test(key) &&
    /^(?:completed|pending|passed|failed|running|stopped|repairing|cancelled|starting|queued|ready|idle|staging|live|ok|plan|execute|item|message|function|tool|system|developer|assistant|user|old|new)$/.test(value);
}

class LiteralSecrets {
  protected readonly knownSecrets = new Set<string>();
  private sortedSecrets?:string[];

  register(secret: string | null | undefined): void {
    if (secret && !this.knownSecrets.has(secret)) {
      this.knownSecrets.add(secret);
      this.sortedSecrets=undefined;
    }
  }

  endsWithSecretPrefix(text: string): boolean {
    for (const secret of this.knownSecrets) {
      let start = text.indexOf(secret[0], Math.max(0, text.length - secret.length + 1));
      while (start >= 0) {
        if (secret.startsWith(text.slice(start))) return true;
        start = text.indexOf(secret[0], start + 1);
      }
    }
    return false;
  }

  get empty() { return this.knownSecrets.size===0; }
  has(value:string) {return this.knownSecrets.has(value);}

  maskLiterals(value: string, protocol?:LiteralSecrets): string {
    let result = value;
    this.sortedSecrets ??= [...this.knownSecrets].sort((left, right) => right.length - left.length);
    const marker="[REDACTED]";
    for (const secret of this.sortedSecrets) {
      // Short .env settings (such as DEBUG=1) can coincide with part of an unrelated UUID or timestamp.
      if (protocol && secret.length<=4 && protocol.has(secret) && secret!==value) continue;
      if (!result.includes(secret)) continue;
      // A short literal vault value can also occur in the redaction marker.
      result = marker.includes(secret) ? result.split(marker).map(part=>part.split(secret).join(marker)).join(marker)
        : result.split(secret).join(marker);
    }
    return result;
  }
}

export class SecretMasker extends LiteralSecrets {
  readonly workspace = new LiteralSecrets();
  private onNewLiteral?: (value: string) => void;

  observeLiterals(observer?: (value: string) => void) {
    this.onNewLiteral = observer;
    if (observer) for (const value of this.knownSecrets) observer(value);
  }

  override register(value: string | null | undefined) {
    if (!value || this.has(value)) return;
    super.register(value);
    this.onNewLiteral?.(value);
  }

  maskString(value: string, protocol=false): string {
    let result=this.maskLiterals(value,protocol ? this.workspace : undefined);
    for (const pattern of secretPatterns) result = result.replace(pattern, "[REDACTED]");
    return result;
  }

  maskObject<T>(value: T, protocol=false): T {
    if (typeof value === "string") return this.maskString(value,protocol) as T;
    if (Array.isArray(value)) return value.map((item) => this.maskObject(item,protocol)) as T;
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      this.maskString(key,/^[A-Za-z][A-Za-z0-9_]*$/.test(key)), /^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|(?:client[_-]?)?secret|password|cookie|set-cookie)$/i.test(key)
        ? (item == null ? item : "[REDACTED]")
        : this.maskObject(item,protocolField(key,item)),
    ])) as T;
  }
}

export function maskApiKeySuffix(apiKey: string | null): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 4) return "...";
  const suffix = apiKey.slice(-4);
  return apiKey.startsWith("sk-") ? `sk-...${suffix}` : `...${suffix}`;
}
