import { randomBytes } from "node:crypto";
import { createServer as createReceiver } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, test } from "vitest";
import { migrations,runMigrations } from "../src/db/migrations.js";
import { schema } from "../src/db/schema.js";
import { parseGatewayConfig } from "../src/app.js";
import { Notifications } from "../src/notifications/index.js";
import { SecretMasker } from "../src/security/secret-masker.js";

test("upgrades a populated V1 store twice, preserving artifacts and sealing legacy notification configuration",async () => {
  const db = new Database(":memory:");
  let received = "";
  const receiver = createReceiver(async (req,res) => {
    for await (const chunk of req) received+=chunk;
    res.writeHead(204).end();
  });
  try {
    receiver.listen(0,"127.0.0.1");
    await once(receiver,"listening");
    const url="http://127.0.0.1:"+(receiver.address() as AddressInfo).port+"/private-hook";
    db.exec(migrations[0].sql);
    db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(1,'old');
      INSERT INTO workspaces VALUES('ws','workspace','sample','old','old');
      INSERT INTO threads VALUES('thr','ws','title','idle','old','old');
      INSERT INTO thread_events VALUES('event','thr',3,'sample','{}','old');
      INSERT INTO artifacts VALUES('a','thr','result','result.txt','text/plain','old');`);
    db.prepare("INSERT INTO notification_channels VALUES('c','test','webhook',?,1,'old','old')").run(JSON.stringify({url}));
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT version FROM schema_migrations ORDER BY version").pluck().all()).toEqual([1,2,3,4,5,6,7]);
    expect(db.prepare("SELECT workspace_id FROM artifacts WHERE id='a'").pluck().get()).toBe("ws");
    expect(db.prepare("SELECT sequence FROM thread_events WHERE id='event'").pluck().get()).toBe(3);
    const ctx={native:db,orm:drizzle(db,{schema}),masterKey:randomBytes(32),masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()};
    const notifications=new Notifications(ctx);
    expect(db.prepare("SELECT config_json FROM notification_channels").pluck().get()).not.toContain("private-hook");
    await notifications.send("task_failed",{detail:"sk-synthetic-secret-key-1234"});
    expect(JSON.parse(received)).toEqual({event:"task_failed",data:{detail:"[REDACTED]"}});
  } finally {
    receiver.closeAllConnections();
    if(receiver.listening) await new Promise<void>(resolve=>receiver.close(()=>resolve()));
    db.close();
  }
});
