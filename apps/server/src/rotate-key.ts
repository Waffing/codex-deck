import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { decryptSecret, encryptSecret, loadMasterKey, rotationProof } from './security/crypto.js';
import { workspaceFile } from './security/paths.js';

/** Stop the service before switching keys. SQLite commits all credential envelopes together. */
export function rotateMasterKey(db: Database.Database, current: Buffer, next: Buffer) {
  if (timingSafeEqual(current, next)) throw new Error('Choose two distinct keys.');
  db.pragma('locking_mode = EXCLUSIVE');
  return db.transaction(() => {
    const marker = db.prepare("SELECT value FROM settings WHERE key='crypto.key-check'").pluck().get();
    if (marker === rotationProof(next)) return 'Already rotated. Configure the new master key before starting the service.';
    if (marker != null && marker !== rotationProof(current)) throw new Error('Current key does not match this database.');
    const seal = (value: string) => value ? encryptSecret(decryptSecret(value, current), next) : value;
    const hasPool=db.prepare("SELECT 1 FROM pragma_table_info('providers') WHERE name='api_keys_enc'").get();
    const provider = db.prepare(`UPDATE providers SET api_key_ciphertext=?, headers_json=? ${hasPool?",api_keys_enc=?, balance_token_enc=?":""} WHERE id=?`);
    for (const row of db.prepare('SELECT * FROM providers').all() as {id:string;api_key_ciphertext:string|null;headers_json:string;api_keys_enc:string|null;balance_token_enc:string|null}[]) {
      const headers: Record<string, string> = JSON.parse(row.headers_json);
      const renewed = Object.fromEntries(Object.entries(headers).map(([name,value]) => [name, seal(value)]));
      provider.run(row.api_key_ciphertext === null ? null : seal(row.api_key_ciphertext), JSON.stringify(renewed),
        ...(hasPool?[row.api_keys_enc?seal(row.api_keys_enc):null,row.balance_token_enc?seal(row.balance_token_enc):null]:[]),row.id);
    }
    const channel = db.prepare('UPDATE notification_channels SET config_json=? WHERE id=?');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_secrets'").get()) {
      const update = db.prepare('UPDATE workspace_secrets SET value_enc=?,description=? WHERE id=?');
      for (const row of db.prepare('SELECT id,value_enc,description FROM workspace_secrets').all() as {id:string;value_enc:string;description:string}[]) {
        update.run(seal(row.value_enc), seal(row.description), row.id);
      }
    }
    for (const row of db.prepare('SELECT id,config_json FROM notification_channels').all() as {id:string;config_json:string}[]) {
      const config = row.config_json.startsWith('v1.') ? seal(row.config_json) : encryptSecret(JSON.stringify(JSON.parse(row.config_json)), next);
      channel.run(config, row.id);
    }
    const task = db.prepare('UPDATE tasks SET webhook_url=? WHERE id=?');
    for (const row of db.prepare('SELECT id,webhook_url FROM tasks WHERE webhook_url IS NOT NULL').all() as {id:string;webhook_url:string}[]) {
      task.run(seal(row.webhook_url), row.id);
    }
    for (const row of db.prepare("SELECT key,value FROM settings WHERE key IN ('security.totp','security.totp_pending','security.recovery')").all() as {key:string;value:string}[]) {
      db.prepare("UPDATE settings SET value=? WHERE key=?").run(seal(row.value),row.key);
    }
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_sessions'").get()) db.prepare("UPDATE user_sessions SET revoked=1").run();
    db.prepare("DELETE FROM settings WHERE key LIKE 'session:%'").run();
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('crypto.key-check',?,?)").run(rotationProof(next), new Date().toISOString());
    return 'Rotated. Configure the new master key before starting the service.';
  }).exclusive();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const directory = await realpath(process.argv[2] ?? process.env.CODEXDECK_DATA_DIR ?? '');
    const configuredNext = process.env.CODEXDECK_NEXT_MASTER_KEY;
    if (!configuredNext || !process.env.CODEXDECK_MASTER_KEY) throw new Error('Set CODEXDECK_MASTER_KEY and CODEXDECK_NEXT_MASTER_KEY through your secret manager.');
    const current = await loadMasterKey(directory, process.env.CODEXDECK_MASTER_KEY);
    const next = await loadMasterKey(directory, configuredNext);
    const file = await workspaceFile(path.dirname(directory),path.join(directory,'codexdeck.sqlite'));
    const db = new Database(file, {fileMustExist:true, timeout:2000});
    try { console.info(rotateMasterKey(db,current,next)); } finally { db.close(); }
  } catch { console.error('Rotation did not complete. Stop all database users and check both secret inputs. Retain the pre-rotation backup.'); process.exitCode = 1; }
}
