import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createServer, parseGatewayConfig } from "../src/app.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "../src/db/schema.js";
import { migrations,runMigrations } from '../src/db/migrations.js';
import { decryptSecret, encryptSecret, signPayload, verifySignedPayload } from '../src/security/crypto.js';
import { rotateMasterKey } from '../src/rotate-key.js';

it('rotates secrets atomically and can resume after a committed rotation', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const current=randomBytes(32), next=randomBytes(32);
    const oldToken=signPayload({aud:'artifact-download'},current);
    const insert=db.prepare('INSERT INTO providers(id,name,preset,base_url,api_key_ciphertext,headers_json,quirks_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)');
    insert.run('one','test','custom','https://example.com',encryptSecret('fixture',current),JSON.stringify({other:encryptSecret('header',current)}),'{}','','');
    const read=()=>db.prepare("SELECT api_key_ciphertext FROM providers WHERE id='one'").pluck().get() as string;
    db.prepare("INSERT INTO notification_channels(id,name,type,config_json,enabled,created_at,updated_at) VALUES('a','x','webhook','v1.broken',1,'','')").run();
    expect(()=>rotateMasterKey(db,current,next)).toThrow();
    expect(decryptSecret(read(),current)).toBe('fixture');
    db.prepare('UPDATE notification_channels SET config_json=?').run(encryptSecret('{}',current));
    expect(rotateMasterKey(db,current,next)).toMatch(/^Rotated/);
    expect(decryptSecret(read(),next)).toBe('fixture');
    expect(decryptSecret(JSON.parse(db.prepare('SELECT headers_json FROM providers').pluck().get() as string).other,next)).toBe('header');
    expect(verifySignedPayload(oldToken,next)).toBeNull();
    expect(()=>createServer({native:db,orm:drizzle(db,{schema}),masterKey:current,masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()})).toThrow(/master key/);
    expect(rotateMasterKey(db,current,next)).toMatch(/^Already rotated/);
  } finally { db.close(); }
});

it("migrates a populated v4 key once and rotates both the encrypted pool and independent balance token",async()=>{
  const db=new Database(":memory:");
  const current=randomBytes(32),next=randomBytes(32);
  const inferenceKey="fixture-v4-opaque-credential",balanceToken="fixture-separate-manager";
  const context=(key:Buffer)=>({native:db,orm:drizzle(db,{schema}),masterKey:key,masker:new SecretMasker(),gatewayConfig:parseGatewayConfig()});
  try {
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)");
    for(const m of migrations.filter(m=>m.version<=4)) {
      db.exec(m.sql);db.prepare("INSERT INTO schema_migrations VALUES(?,?)").run(m.version,"previous");
    }
    db.prepare("INSERT INTO providers(id,name,preset,base_url,api_key_ciphertext,headers_json,quirks_json,created_at,updated_at) VALUES('p','p','custom','https://example.org/v1',?,'{}','{}','','')")
      .run(encryptSecret(inferenceKey,current));
    runMigrations(db);
    const getPool=()=>db.prepare("SELECT api_keys_enc FROM providers").pluck().get() as string;
    const first=context(current);
    await createServer(first).close();
    const envelope=getPool();
    const entries=JSON.parse(decryptSecret(envelope,current));
    expect(entries).toEqual([{id:expect.any(String),value:inferenceKey}]);
    runMigrations(db);
    db.prepare("UPDATE providers SET balance_token_enc=?").run(encryptSecret(balanceToken,current));
    await createServer(context(current)).close();
    expect(getPool()).toBe(envelope);
    rotateMasterKey(db,current,next);
    expect(()=>decryptSecret(getPool(),current)).toThrow();
    expect(JSON.parse(decryptSecret(getPool(),next))).toEqual(entries);
    const final=context(next);
    await createServer(final).close();
    expect(final.masker.maskString(inferenceKey+"/"+balanceToken)).toBe("[REDACTED]/[REDACTED]");
  } finally {db.close();}
});
