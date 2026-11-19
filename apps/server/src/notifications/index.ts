import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { notificationChannelCreateSchema } from "@codexdeck/shared";
import { encryptSecret, decryptSecret } from "../security/crypto.js";

type Config = { url?: string; token?: string; chat_id?: string };
type Channel = { id: string; name: string; type: string; config_json: string; enabled: number; created_at:string; updated_at:string };
function dto({id,name,type,enabled,created_at,updated_at}: Channel) {
  return { id,name,type,enabled: !!enabled,created_at,updated_at };
}

export class Notifications {
  constructor(private readonly ctx: ServerContext) {
    ctx.native.transaction(() => {
      for (const channel of this.list()) {
        // V1 reserved config_json before the notification API existed.
        if (!channel.config_json.startsWith("v1.")) {
          const json = JSON.stringify(JSON.parse(channel.config_json));
          channel.config_json = encryptSecret(json,ctx.masterKey);
          ctx.native.prepare("UPDATE notification_channels SET config_json=? WHERE id=?").run(channel.config_json,channel.id);
        }
        this.config(channel);
      }
    })();
  }

  list() { return this.ctx.native.prepare("SELECT * FROM notification_channels ORDER BY created_at").all() as Channel[]; }

  private config(channel: Channel): Config {
    const config: Config = JSON.parse(decryptSecret(channel.config_json, this.ctx.masterKey));
    this.ctx.masker.register(config.url);
    this.ctx.masker.register(config.token);
    return config;
  }

  private async deliver(channel: Channel, kind: string, payload: unknown) {
    const safe = this.ctx.masker.maskObject(payload);
    const text = kind + "\n" + JSON.stringify(safe);
    const cfg = this.config(channel);
    let url = cfg.url;
    let body: object = { event: kind, data: safe };
    if (channel.type === "telegram") {
      url = "https://api.telegram.org/bot" + cfg.token + "/sendMessage";
      body = { chat_id: cfg.chat_id, text };
    } else if (channel.type === "feishu") body = { msg_type: "text", content: { text } };
    else if (channel.type === "bark") body = { title: "CodexDeck", body: text };
    const response = await fetch(url!, { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify(body),
      redirect:"error", signal:AbortSignal.timeout(5000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Notification delivery failed.");
  }

  async send(kind:string,payload:unknown) {
    await Promise.allSettled(this.list().filter(channel=>channel.enabled).map(channel=>this.deliver(channel,kind,payload)));
  }

  async test(id:string) {
    const item=this.list().find(channel=>channel.id===id);
    if (!item) return false;
    await this.deliver(item,"channel_test",{message:"CodexDeck notification test"});
    return true;
  }
}

export function registerNotifications(app: FastifyInstance, ctx: ServerContext, notifications: Notifications) {
  const auth = { preHandler:createRequireAdmin(ctx) };
  app.get("/api/notification-channels",auth,async () => notifications.list().map(dto));
  app.post<{Params:{id:string}}>("/api/notification-channels/:id/test",auth,async(req,reply)=>{
    try {
      return await notifications.test(req.params.id) ? {ok:true} : reply.code(404).send({error:"Notification channel missing."});
    } catch {
      return reply.code(502).send({error:"Test notification could not be delivered."});
    }
  });
  app.post("/api/notification-channels",auth,async (req,reply) => {
    const parsed = notificationChannelCreateSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({error:"Invalid notification channel."});
    const channel = parsed.data;
    const now = new Date().toISOString();
    ctx.masker.register(channel.config.token);
    ctx.masker.register(channel.config.url);
    const record = ctx.native.prepare(`INSERT INTO notification_channels(id,name,type,config_json,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) RETURNING *`).get(randomUUID(),channel.name,channel.type,encryptSecret(JSON.stringify(channel.config),ctx.masterKey),
        Number(channel.enabled),now,now) as Channel;
    return reply.code(201).send(dto(record));
  });
  app.delete<{Params:{id:string}}>("/api/notification-channels/:id",auth,async (req,reply) =>
    reply.code(ctx.native.prepare("DELETE FROM notification_channels WHERE id=?").run(req.params.id).changes ? 204 : 404).send());
}
