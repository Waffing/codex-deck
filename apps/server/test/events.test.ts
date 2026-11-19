import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect,test } from "vitest";
import { runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { parseGatewayConfig } from "../src/app.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { ThreadEvents,registerEventRoutes } from "../src/ws/events.js";
import { SecretMasker } from "../src/security/secret-masker.js";

test("WebSocket replays precisely 4–8, masks stored and live events, then delivers 9",async () => {
  const native = new Database(":memory:");
  runMigrations(native);
  native.prepare("INSERT INTO threads(id,title,status,created_at,updated_at) VALUES('thread','fixture','idle','','')").run();
  const ctx={native,orm:drizzle(native,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
  const secret="fixture-private-event-key";
  ctx.masker.register(secret);
  const events=new ThreadEvents(ctx);
  const app=Fastify();
  app.register(websocket);
  app.register(async scoped => { registerAuthRoutes(scoped,ctx); registerEventRoutes(scoped,ctx,events); });
  const connected:WebSocket[]=[];
  try {
    const url=(await app.listen({port:0,host:"127.0.0.1"})).replace(/^http:/,"ws:");
    const setup=await app.inject({method:"POST",url:"/api/auth/setup",payload:{password:"websocket-test-password"}});
    const cookie=String(setup.headers["set-cookie"]).split(";")[0];
    const open=(after:number)=>{
      const socket=new WebSocket(url+"/ws/events?thread_id=thread&last_seq_id="+after,{headers:{cookie}});
      connected.push(socket);
      const received:{seq_id:number;payload:unknown}[]=[];
      socket.on("message",bytes=>{const frame=JSON.parse(bytes.toString()); if(frame.type==="event") received.push(frame.event);});
      return {socket,received};
    };
    const a=open(0);
    await once(a.socket,"open");
    const publish=(n:number)=>events.append("thread","delta",{text:n+" "+secret});
    [1,2,3].forEach(publish);
    await expect.poll(()=>a.received.map(e=>e.seq_id)).toEqual([1,2,3]);
    a.socket.close();
    await once(a.socket,"close");
    [4,5,6,7,8].forEach(publish);
    const b=open(3);
    await expect.poll(()=>b.received.map(e=>e.seq_id)).toEqual([4,5,6,7,8]);
    publish(9);
    await expect.poll(()=>b.received.map(e=>e.seq_id)).toEqual([4,5,6,7,8,9]);
    expect(JSON.stringify(b.received)).not.toContain(secret);
    const stored=native.prepare("SELECT payload_json FROM thread_events").pluck().all();
    expect(stored).toHaveLength(9);
    expect(stored.every(s=>String(s).includes("[REDACTED]"))).toBe(true);
  } finally { for (const s of connected) s.terminate(); await app.close(); native.close(); }
});
