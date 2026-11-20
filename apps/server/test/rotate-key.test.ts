import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { createServer, parseGatewayConfig } from "../src/app.js";
import { SecretMasker } from "../src/security/secret-masker.js";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { schema } from "../src/db/schema.js";
import { runMigrations } from '../src/db/migrations.js';
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
