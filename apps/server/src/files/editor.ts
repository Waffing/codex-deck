import { createHash } from "node:crypto";
import type { SecretMasker } from "../security/secret-masker.js";
import { fileError, openWorkspaceFile, resolveSafeWorkspacePath, saveWorkspaceFile } from "./sandbox.js";

const limit = 1024 * 1024;
const busy = new Set<string>();

export async function readEditable(root:string, name:string, masker:SecretMasker) {
  const file = await openWorkspaceFile(root,name);
  try {
    if ((await file.stat()).size > limit) throw fileError(413,"File exceeds preview limit.");
    const chunks:Buffer[] = [];
    let length = 0;
    for await (const chunk of file.createReadStream({autoClose:false})) {
      length += chunk.length;
      if (length > limit) throw fileError(413,"File exceeds preview limit.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const original = bytes.toString("utf8");
    const content = masker.maskString(original);
    return {content, size:length, revision:createHash("sha256").update(bytes).digest("hex"),
      read_only:content !== original || !Buffer.from(original).equals(bytes) || original.includes("\0")};
  } finally { await file.close(); }
}

export async function writeEditable(root:string, name:string, value:string, revision:string|undefined, masker:SecretMasker) {
  if (Buffer.byteLength(value) > limit) throw fileError(413,"File exceeds editor limit.");
  const target = await resolveSafeWorkspacePath(root,name);
  if (busy.has(target)) throw fileError(409,"Another save is in progress.");
  busy.add(target);
  try {
    await saveWorkspaceFile(root,name,value,async () => {
      let current;
      try { current = await readEditable(root,name,masker); }
      catch (e) { if ((e as {statusCode?:number}).statusCode !== 404) throw e; }
      if (current?.read_only) throw fileError(403,"This file contains masked or binary data and is read-only.");
      if (current && revision === undefined) throw fileError(428,"Provide the revision you opened.");
      if ((current?.revision ?? "missing") !== (revision ?? "missing")) throw fileError(409,"File changed since it was opened.");
    });
    return createHash("sha256").update(value).digest("hex");
  } finally { busy.delete(target); }
}
