import type Database from "better-sqlite3";
import {workbenchPreferencesSchema, type WorkbenchPreferences} from "@codexdeck/shared";

export function readPreferences(db: Database.Database): WorkbenchPreferences {
  const value = db.prepare("SELECT value FROM settings WHERE key='workbench.preferences'").pluck().get();
  return workbenchPreferencesSchema.parse(typeof value === "string" ? JSON.parse(value) : {});
}

export function patchPreferences(db: Database.Database, patch: Partial<WorkbenchPreferences>) {
  return db.transaction(() => {
    const next = workbenchPreferencesSchema.parse({...readPreferences(db), ...patch});
    db.prepare("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('workbench.preferences',?,?)")
      .run(JSON.stringify(next),new Date().toISOString());
    return next;
  }).immediate();
}
