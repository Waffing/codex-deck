import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,mkdir,writeFile,rm,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {runVerifyGate} from "../dist/codex/verify-gate.js";
import {SecretMasker} from "../dist/security/secret-masker.js";

const mode=process.env.CODEXDECK_VERIFY_SMOKE;
assert.ok(["docker","native"].includes(mode));
assert.equal(Boolean(process.env.CODEXDECK_EXECUTOR_IMAGE||process.env.CODEXDECK_DEPLOYMENT_NETWORK),mode==="docker");
const dir=await mkdtemp(path.join(tmpdir(),"deck-verify-"));
try {
  const data=path.join(dir,"data"),root=path.join(dir,"project"),credential=randomUUID(),masker=new SecretMasker();
  await mkdir(data);await mkdir(root);await writeFile(path.join(data,"marker"),"private");
  await writeFile(path.join(root,"README"),"fixture");
  masker.register(credential);
  const progress=[],controller=new AbortController();
  const opts={root,data,env:{WORKSPACE_TEST:credential},masker,signal:controller.signal,attempt:0,progress:e=>progress.push(structuredClone(e)),
    config:{auto_verify_enabled:true,max_self_heal_retries:2,review_model_alias:null,verify_network_enabled:false,
      verify_commands:["test -r README && test -n \"$WORKSPACE_TEST\" && printf %s \"$WORKSPACE_TEST\" && touch build-output",
        'test -f build-output && test ! -w /source && test ! -e /var/run/docker.sock && test -z "${CODEXDECK_MASTER_KEY:-}"',
        'test ! -e '+JSON.stringify(path.join(data,"marker"))+' && test "$(ls /sys/class/net 2>/dev/null | grep -v ^lo$ | wc -l)" -eq 0']}};
  const success=await runVerifyGate(opts);
  assert.equal(success.status,"passed",JSON.stringify(success));
  assert.equal(success.commands.length,3);
  assert.match(success.commands[0].output,/REDACTED/);
  assert.ok(!JSON.stringify([success,progress]).includes(credential));
  assert.deepEqual(await readdir(root),["README"]);
  const aborted=await runVerifyGate({...opts,config:{...opts.config,verify_commands:["sleep 120"]},progress:()=>controller.abort()});
  assert.equal(aborted.status,"cancelled");
  console.log(mode+" verification sandbox passed: ordered commands, secret masking, read-only source, private environment, cancellation");
} finally {await rm(dir,{recursive:true,force:true});}
