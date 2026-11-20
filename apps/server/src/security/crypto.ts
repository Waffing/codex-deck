import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { readOrCreateFileKey } from "../db/index.js";

const scrypt = promisify(scryptCallback);

export async function loadMasterKey(dataDirectory: string, configured = process.env.CODEXDECK_MASTER_KEY, workspaceRoot?: string): Promise<Buffer> {
  if (!configured) return readOrCreateFileKey(dataDirectory, workspaceRoot);
  if (/^[0-9a-fA-F]{64}$/.test(configured)) return Buffer.from(configured, "hex");
  const decoded = Buffer.from(configured, "base64");
  if (decoded.length !== 32 || decoded.toString("base64").replace(/=+$/, "") !== configured.replace(/=+$/, "")) {
    throw new Error("CODEXDECK_MASTER_KEY must be a 32-byte base64 value or 64-character hex value.");
  }
  return decoded;
}

export function rotationProof(key: Uint8Array): string {
  return createHmac("sha256",key).update("codexdeck:key-rotation:v1").digest("hex");
}

export function encryptSecret(secret: string, masterKey: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string, masterKey: Uint8Array): string {
  const [version, ivPart, tagPart, dataPart, extra] = envelope.split(".");
  if (version !== "v1" || !ivPart || !tagPart || dataPart === undefined || extra !== undefined) {
    throw new Error("Unsupported encrypted credential format.");
  }
  const iv = Buffer.from(ivPart, "base64url");
  if (iv.length !== 12) throw new Error("Invalid credential nonce.");
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv, { authTagLength: 16 });
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64url")), decipher.final()]).toString("utf8");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, saltPart, hashPart, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltPart || !hashPart || extra !== undefined) return false;
  const salt = Buffer.from(saltPart, "base64url");
  const expected = Buffer.from(hashPart, "base64url");
  if (expected.length !== 64) return false;
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function signPayload(payload: Record<string, unknown>, key: Uint8Array): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifySignedPayload(token: string, key: Uint8Array): Record<string, unknown> | null {
  const [body, providedSignature, extra] = token.split(".");
  if (!body || !providedSignature || extra !== undefined) return null;
  const expected = createHmac("sha256", key).update(body).digest();
  const provided = Buffer.from(providedSignature, "base64url");
  if (provided.toString("base64url") !== providedSignature || expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function createInternalToken(key: Uint8Array, ttlSeconds = 3600, threadId?: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signPayload({ aud: "codexdeck-internal", thread_id: threadId, iat: now, exp: now + ttlSeconds, nonce: randomBytes(16).toString("hex") }, key);
}

export function verifyInternalToken(token: string, key: Uint8Array): boolean {
  const payload = verifySignedPayload(token, key);
  const now = Math.floor(Date.now() / 1000);
  return payload?.aud === "codexdeck-internal"
    && typeof payload.iat === "number"
    && typeof payload.exp === "number"
    && payload.iat <= now + 30
    && payload.exp > now
    && payload.exp - payload.iat <= 86400
    && typeof payload.nonce === "string";
}
