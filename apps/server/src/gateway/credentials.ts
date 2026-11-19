import type { ServerContext } from "../app.js";
import { decryptSecret, encryptSecret } from "../security/crypto.js";
import { providers } from "../db/schema.js";

type Context = Pick<ServerContext, "masterKey" | "masker">;
type Stored = Pick<typeof providers.$inferSelect, "apiKeyCiphertext" | "headersJson">;

export function sealHeaders(headers: Record<string, string>, context: Context): string {
  return JSON.stringify(Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    registerHeader(name, value, context);
    return [name, value ? encryptSecret(value, context.masterKey) : ""];
  })));
}

function registerHeader(name: string, value: string, context: Context) {
  if (!value) return;
  // Header names are administrator-defined, including nonstandard credential names.
  context.masker.register(value);
  if (/^authorization$/i.test(name)) context.masker.register(value.replace(/^\S+\s+/, ""));
}

export function readCredentials(provider: Stored, context: Context) {
  const apiKey = provider.apiKeyCiphertext ? decryptSecret(provider.apiKeyCiphertext, context.masterKey) : "";
  context.masker.register(apiKey);
  const sealed: Record<string, string> = JSON.parse(provider.headersJson);
  const headers = Object.fromEntries(Object.entries(sealed).map(([name, encrypted]) => {
    const value = encrypted ? decryptSecret(encrypted, context.masterKey) : "";
    registerHeader(name, value, context);
    return [name, value];
  }));
  return { apiKey, headers };
}

export function registerStoredCredentials(context: ServerContext) {
  const stored = context.orm.select({
    apiKeyCiphertext: providers.apiKeyCiphertext, headersJson: providers.headersJson,
  }).from(providers).all();
  for (const provider of stored) readCredentials(provider, context);
}
