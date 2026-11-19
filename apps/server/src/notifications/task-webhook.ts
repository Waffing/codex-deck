import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";
import type { ServerContext } from "../app.js";
import { decryptSecret } from "../security/crypto.js";

export function webhookSecret(ctx: ServerContext, keyId: string) {
  return createHmac("sha256",ctx.masterKey).update("codexdeck:webhook:v1:" + keyId).digest("base64url");
}

export function callbackUrl(value: string, origins: string[]) {
  const url = new URL(value);
  if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid webhook URL.");
  if (origins.length && !origins.includes(url.origin)) throw new Error("Webhook origin not permitted.");
  return url;
}

async function postPinned(url: URL, origins: string[], body: string, signature: string) {
  const hostname = url.hostname.replace(/^\[|\]$/g,"");
  const addresses = await dns.lookup(hostname,{all:true});
  const allowedPrivate = origins.includes(url.origin);
  if (!addresses.length || (!allowedPrivate && addresses.some(a => ipaddr.process(a.address).range() !== "unicast"))) {
    throw new Error("Webhook destination not permitted.");
  }
  const ip = addresses[0];
  // Connect to the vetted address while preserving the original Host and TLS identity.
  await new Promise<void>((resolve,reject) => {
    const req = (url.protocol === "https:" ? https : http).request({
      hostname:ip.address, family:ip.family, port:url.port || undefined, method:"POST",
      servername:hostname, path:url.pathname + url.search, agent:false, signal:AbortSignal.timeout(5000),
      headers:{host:url.host, "content-type":"application/json","X-CodexDeck-Signature":"sha256=" + signature},
    },res => {
      const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
      res.destroy();
      if (ok) resolve(); else reject(new Error("Webhook rejected."));
    });
    req.on("error",reject);
    req.end(body);
  });
}

type Due = {id:string; thread_id:string; workspace_id:string; api_key_id:string; webhook_url:string; webhook_origins_json:string;
  webhook_attempts:number; status:string; summary:string};

export class TaskWebhooks {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  constructor(private ctx:ServerContext) {}
  start() {
    this.timer = setInterval(() => this.kick(), 500);
    this.timer.unref();
    this.kick();
  }
  kick() { this.running ??= this.deliver().finally(() => { this.running = undefined; }); }
  async close() { clearInterval(this.timer); await this.running; }
  private async deliver() {
    const db = this.ctx.native;
    const due = db.prepare(`SELECT t.*, k.webhook_origins_json FROM tasks t JOIN api_keys k ON k.id=t.api_key_id
      WHERE t.webhook_state='pending' AND k.revoked_at IS NULL AND t.status IN ('completed','failed','cancelled') AND t.webhook_next_at<=?
      ORDER BY t.updated_at LIMIT 12`).all(Date.now()) as Due[];
    await Promise.all(due.map(async row => {
      const attempts = row.webhook_attempts+1;
      const origins = JSON.parse(row.webhook_origins_json) as string[];
      try {
        const body = JSON.stringify(this.ctx.masker.maskObject({event:"task_" + row.status,task_id:row.id,thread_id:row.thread_id,
          workspace_id:row.workspace_id,status:row.status,summary:row.summary}));
        const signature = createHmac("sha256",webhookSecret(this.ctx,row.api_key_id)).update(body).digest("hex");
        const url = callbackUrl(decryptSecret(row.webhook_url,this.ctx.masterKey),origins);
        await postPinned(url,origins,body,signature);
        db.prepare("UPDATE tasks SET webhook_state='sent',webhook_attempts=? WHERE id=?").run(attempts,row.id);
      } catch {
        db.prepare("UPDATE tasks SET webhook_state=?,webhook_attempts=?,webhook_next_at=? WHERE id=?")
          .run(attempts>=6?"failed":"pending",attempts,Date.now()+1000*2**(attempts-1),row.id);
      }
    }));
  }
}
