import { randomUUID } from "node:crypto";
import type { VerifyInput } from "@codexdeck/shared";
import type { SecretMasker } from "../security/secret-masker.js";
import type { WorkspaceFiles } from "../files/workspace-files.js";
import { ensureDirectory, resolveSafeWorkspacePath } from "../files/sandbox.js";
import { writeFile } from "node:fs/promises";

async function boundedText(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks:Uint8Array[]=[];
  let length=0;
  try {
    while(length<1024*1024) {
      const {value,done} = await reader.read();
      if(done) break;
      const chunk=value.subarray(0,1024*1024-length);
      chunks.push(chunk); length+=chunk.length;
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function verifyUrl(input: VerifyInput, port: number, logs: string, workspace:string, thread:string|null, turn:string|null, files:WorkspaceFiles, masker:SecretMasker, upstreamOrigin?:string) {
  const origin = upstreamOrigin ?? "http://127.0.0.1:"+port;
  const url = new URL(input.path,origin);
  if(url.origin !== origin) throw new Error("Expected a relative deployment path.");
  const started=performance.now();
  let status=0;
  let error:string|null=null;
  let contentMatch=false;
  try {
    const res=await fetch(url,{redirect:"manual",signal:AbortSignal.timeout(5000)});
    status=res.status;
    const body=await boundedText(res);
    contentMatch=input.expected_content === undefined || body.includes(input.expected_content);
  } catch { error="Could not reach deployment."; }
  const issues=masker.maskString(logs).split(/\r?\n/).filter(line=>/\b(?:crash(?:ed)?|traceback|unhandled(?:promise)?rejection|uncaught(?:exception)?)\b/i.test(line)).slice(-30);
  const report = {ok:status>=200 && status<300 && contentMatch && issues.length===0,
    http:{status,latency_ms:Math.round(performance.now()-started),content_match:contentMatch,error},logs:{issues},
    browser:{status:"disabled",message:"",issues:[] as string[],artifacts:[] as string[]} };
  if(!input.check_browser) return report;
  let browser;
  try {
    const {chromium}=await import("playwright-core");
    browser=await chromium.launch({headless:true,chromiumSandbox:true});
  } catch {
    report.browser.status="unavailable";report.browser.message="Chromium is unavailable. Install a compatible Playwright Chromium to enable screenshots.";
    return report;
  }
  report.browser.status="completed";
  try {
    const root=await files.getRoot(workspace);
    await ensureDirectory(root,".codex-artifacts");
    for(const viewport of [{width:1440,height:900},{width:390,height:844}]) {
      const ctx=await browser.newContext({viewport,serviceWorkers:"block",acceptDownloads:false});
      try {
        // A deployment cannot use the verifier's browser as a proxy to the control plane.
        await ctx.route("**/*",route=> {
          const target=new URL(route.request().url());
          return target.origin===origin ? route.continue() : route.abort();
        });
        await ctx.routeWebSocket("**/*",socket=>socket.close());
        const page=await ctx.newPage();
        const issue=(message:string)=>{ if(report.browser.issues.length<60) report.browser.issues.push(masker.maskString(message.slice(0,2048))); };
        page.on("console",msg=>{if(msg.type()==="error") issue(msg.text());});
        page.on("pageerror",err=>issue(err.message));
        page.on("response",res=>{if(res.status()>=400) issue(res.status()+" "+new URL(res.url()).pathname);});
        await page.goto(url.href,{waitUntil:"load",timeout:8000});
        const relative=".codex-artifacts/verify-"+viewport.width+"-"+randomUUID()+".png";
        const png=await page.screenshot({timeout:5000});
        await writeFile(await resolveSafeWorkspacePath(root,relative),png,{flag:"wx",mode:0o600});
        const artifact=await files.registerArtifact(workspace,thread,turn,relative,"screenshot");
        report.browser.artifacts.push(artifact.id);
      } finally { await ctx.close(); }
    }
  } catch {
    report.browser.status="failed";report.browser.issues.push("Browser verification did not complete.");
  } finally { await browser.close(); }
  report.ok &&= report.browser.issues.length===0;
  return report;
}
