import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { notificationChannelCreateSchema, notificationChannelPatchSchema } from "@codexdeck/shared";
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

  private list() { return this.ctx.native.prepare("SELECT * FROM notification_channels ORDER BY created_at").all() as Channel[]; }

  channels() { return this.list().map(c=>this.ctx.masker.maskObject(dto(c))); }

  create(input:unknown) {
    const parsed=notificationChannelCreateSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(new Error("Invalid notification channel."),{statusCode:400});
    const channel=parsed.data, now=new Date().toISOString();
    const ciphertext=this.encryptConfig(channel.config);
    const record=this.ctx.native.prepare(`INSERT INTO notification_channels(id,name,type,config_json,enabled,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) RETURNING *`).get(randomUUID(),this.ctx.masker.maskString(channel.name),channel.type,ciphertext,Number(channel.enabled),now,now) as Channel;
    return dto(record);
  }

  update(id:string, input:unknown) {
    const parsed=notificationChannelPatchSchema.safeParse(input);
    if (!parsed.success) throw Object.assign(new Error("Invalid notification channel."),{statusCode:400});
    return this.ctx.native.transaction(()=>{
      const current=this.ctx.native.prepare("SELECT * FROM notification_channels WHERE id=?").get(id) as Channel|undefined;
      if (!current) throw Object.assign(new Error("Notification channel missing."),{statusCode:404});
      const patch=parsed.data;
      const previous=patch.type && patch.type!==current.type ? {} : this.config(current);
      const validated=notificationChannelCreateSchema.safeParse({...dto(current),...patch,config:{...previous,...patch.config}});
      if (!validated.success) throw Object.assign(new Error("Invalid notification channel."),{statusCode:400});
      const channel=validated.data;
      const ciphertext=patch.config || (patch.type && patch.type!==current.type) ? this.encryptConfig(channel.config) : current.config_json;
      const updated=this.ctx.native.prepare(`UPDATE notification_channels SET name=?,type=?,config_json=?,enabled=?,updated_at=? WHERE id=? RETURNING *`)
        .get(this.ctx.masker.maskString(channel.name),channel.type,ciphertext,Number(channel.enabled),new Date().toISOString(),id) as Channel;
      return dto(updated);
    }).immediate();
  }

  remove(id:string) {return this.ctx.native.prepare("DELETE FROM notification_channels WHERE id=?").run(id).changes>0;}

  private encryptConfig(config:Config) {
    this.ctx.masker.register(config.token);
    this.ctx.masker.register(config.url);
    return encryptSecret(JSON.stringify(config),this.ctx.masterKey);
  }

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
  app.get("/api/notification-channels",auth,async () => notifications.channels());
  app.post<{Params:{id:string}}>("/api/notification-channels/:id/test",auth,async(req,reply)=>{
    try {
      return await notifications.test(req.params.id) ? {ok:true} : reply.code(404).send({error:"Notification channel missing."});
    } catch {
      return reply.code(502).send({error:"Test notification could not be delivered."});
    }
  });
  app.post("/api/notification-channels",auth,async (req,reply) => {
    return reply.code(201).send(notifications.create(req.body));
  });
  app.patch<{Params:{id:string}}>("/api/notification-channels/:id",auth,async req=>notifications.update(req.params.id,req.body));
  app.delete<{Params:{id:string}}>("/api/notification-channels/:id",auth,async (req,reply) =>
    reply.code(notifications.remove(req.params.id) ? 204 : 404).send());
}
