import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createInternalToken, decryptSecret, encryptSecret, loadMasterKey, verifyInternalToken,
} from "../src/security/crypto.js";
import { SecretMasker, maskApiKeySuffix } from "../src/security/secret-masker.js";

describe("credential encryption and masking", () => {
  it("uses independent authenticated ciphertexts and detects modification or a wrong key", () => {
    const key = randomBytes(32);
    const plaintext = "test credential/123-密钥";
    const first = encryptSecret(plaintext, key);
    expect(first).not.toContain(plaintext);
    expect(encryptSecret(plaintext, key)).not.toBe(first);
    expect(decryptSecret(first, key)).toBe(plaintext);
    expect(() => decryptSecret(first, randomBytes(32))).toThrow();
    const parts = first.split(".");
    const tag = Buffer.from(parts[2], "base64url");
    tag[0] ^= 1;
    parts[2] = tag.toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  it("loads explicit keys and persists one local-development master key across competing startups", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "codexdeck-key-"));
    const data = path.join(workspace, "data");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await mkdir(data);
      const [first, second] = await Promise.all([loadMasterKey(data, "", workspace), loadMasterKey(data, "", workspace)]);
      expect(first).toHaveLength(32);
      expect(second).toEqual(first);
      expect(await loadMasterKey(data, "", workspace)).toEqual(first);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(first.toString("hex"));
      expect(await loadMasterKey(data, first.toString("hex"), workspace)).toEqual(first);
      expect(await loadMasterKey(data, first.toString("base64"), workspace)).toEqual(first);
      await expect(loadMasterKey(data, "invalid", workspace)).rejects.toThrow();
    } finally {
      warn.mockRestore();
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("redacts known credentials, nested arrays, sensitive field names and common unregistered tokens", () => {
    const masker = new SecretMasker();
    const known = "provider_custom_12345";
    masker.register(known);
    const sk = "sk-live-synthetic-0123456789";
    const github = "ghp_" + "1".repeat(30);
    const bearer = "bearer_token_value";
    const input = {
      [known]: [{ stdout: "stdout " + known + " / " + sk, nested: ["Bearer " + bearer, { stderr: github }] }],
      password: "synthetic-password", Authorization: "synthetic-header", usage: { input_tokens: 19, output_tokens: 3 },
    };
    const result = masker.maskObject(input);
    for (const secret of [known, sk, github, bearer, input.password, input.Authorization]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    expect(result.usage).toEqual({ input_tokens: 19, output_tokens: 3 });
    expect(input.password).toBe("synthetic-password");
    expect(masker.maskString("token " + known)).not.toContain(known);
    expect(maskApiKeySuffix(sk)).toBe("sk-...6789");
    expect(maskApiKeySuffix("abcd")).not.toContain("abcd");
  });

  it("verifies a signed internal token and rejects a forged, expired, or excessive-lifetime token", () => {
    const key = randomBytes(32);
    vi.useFakeTimers();
    try {
      const token = createInternalToken(key, 2);
      expect(verifyInternalToken(token, key)).toBe(true);
      expect(verifyInternalToken(token, randomBytes(32))).toBe(false);
      expect(verifyInternalToken(token + ".extra", key)).toBe(false);
      expect(verifyInternalToken(createInternalToken(key, 86_401), key)).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(verifyInternalToken(token, key)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
