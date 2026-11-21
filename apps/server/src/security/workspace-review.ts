import type {ServerContext} from "../app.js";
import {fileError} from "../files/sandbox.js";

// Uploads run outside the task queue. A credential-bearing gate must see exactly the reviewed workspace.
const uploading=new Map<string,number>(),verifying=new Set<string>();
export function beginGuestUpload(ctx:ServerContext,id:string) {
  if(verifying.has(id)) throw fileError(409,"Verification in progress. Retry the upload when it finishes.");
  ctx.native.prepare("UPDATE workspaces SET verify_external_pending=1 WHERE id=?").run(id);
  uploading.set(id,(uploading.get(id)??0)+1);
  return ()=>{
    const remaining=(uploading.get(id)??1)-1;
    if(remaining) uploading.set(id,remaining);else uploading.delete(id);
  };
}
export function beginReviewedVerification(id:string) {
  if(uploading.has(id)) throw fileError(409,"A guest upload is in progress. Review the workspace after it finishes.");
  verifying.add(id);
  return ()=>{verifying.delete(id);};
}
