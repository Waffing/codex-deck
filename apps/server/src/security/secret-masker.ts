const secretPatterns = [
  /\bcdk_live_[A-Za-z0-9_-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:token|api[_-]?key|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi,
];

export class SecretMasker {
  private readonly knownSecrets = new Set<string>();

  register(secret: string | null | undefined): void {
    if (secret) this.knownSecrets.add(secret);
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

  maskString(value: string): string {
    let result = value;
    for (const secret of [...this.knownSecrets].sort((left, right) => right.length - left.length)) {
      result = result.split(secret).join("[REDACTED]");
    }
    for (const pattern of secretPatterns) result = result.replace(pattern, "[REDACTED]");
    return result;
  }

  maskObject<T>(value: T): T {
    if (typeof value === "string") return this.maskString(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.maskObject(item)) as T;
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      this.maskString(key), /^(?:authorization|proxy-authorization|x-api-key|api[_-]?key|(?:access[_-]?|refresh[_-]?|id[_-]?)?token|(?:client[_-]?)?secret|password|cookie|set-cookie)$/i.test(key)
        ? (item == null ? item : "[REDACTED]")
        : this.maskObject(item),
    ])) as T;
  }
}

export function maskApiKeySuffix(apiKey: string | null): string | null {
  if (!apiKey) return null;
  if (apiKey.length <= 4) return "...";
  const suffix = apiKey.slice(-4);
  return apiKey.startsWith("sk-") ? `sk-...${suffix}` : `...${suffix}`;
}
