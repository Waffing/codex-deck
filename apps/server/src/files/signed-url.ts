import { signPayload, verifySignedPayload } from "../security/crypto.js";
import { fileError } from "./sandbox.js";

export type DownloadSubject = { kind: "artifact" | "turn"; id: string; guest_id?:string } | {kind:"batch"; ids:string[]};

export function signDownload(subject: DownloadSubject, key: Buffer, seconds = 1800) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86400) throw fileError(400, "Invalid link lifetime.");
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return "/api/dl/" + signPayload({ aud: "artifact-download", ...subject, exp }, key);
}

export function validateDownload(token: string, key: Buffer): DownloadSubject {
  // Node's Base64 decoder accepts noncanonical padded/invalid suffixes.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token) ||
    Buffer.from(token.split(".")[1], "base64url").toString("base64url") !== token.split(".")[1]) throw fileError(403, "Invalid download token.");
  const p = verifySignedPayload(token, key);
  if (!p || p.aud !== "artifact-download" || typeof p.exp !== "number" || p.exp <= Math.floor(Date.now() / 1000))
    throw fileError(403, "Invalid download token.");
  if(p.kind==="batch" && Array.isArray(p.ids) && p.ids.length>0 && p.ids.length<=64 && p.ids.every(id=>typeof id==="string")) {
    return {kind:"batch",ids:p.ids as string[]};
  }
  if((p.kind!=="artifact" && p.kind!=="turn") || typeof p.id!=="string") throw fileError(403,"Invalid download token.");
  return { kind: p.kind, id: p.id, ...(typeof p.guest_id==="string" && {guest_id:p.guest_id}) };
}
