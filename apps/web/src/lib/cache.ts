import { useSyncExternalStore } from "react";

type Row = { key: string; scope: string; used: number; bytes: number; value: unknown };
type Stats = { bytes: number; threads: number; enabled: boolean };
const preference = "codexdeck.cache.enabled";
const invalidation = "codexdeck.cache.cleared";
const memory = new Map<string, Row>();
const listeners = new Set<() => void>();
let enabled = localStorage.getItem(preference) !== "false";
let scope = "", generation = 0;
let stats: Stats = { bytes: 0, threads: 0, enabled };
let database: Promise<IDBDatabase | null> | undefined;
let queue: Promise<void> = Promise.resolve();
const threadKey = (key: string) => key.startsWith("thread:");
function updateStats() {
  stats = { enabled, bytes: 0, threads: 0 };
  for (const row of memory.values()) {
    stats.bytes += row.bytes;
    if (threadKey(row.key)) stats.threads++;
  }
  for (const fn of listeners) fn();
}
function open() {
  if (!database) database = new Promise(resolve => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open("codexdeck-workbench", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("entries", { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = req.onblocked = () => resolve(null);
  });
  return database;
}
function transaction(db: IDBDatabase, write: (store: IDBObjectStore) => void) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
    write(tx.objectStore("entries"));
  });
}
function persist(fn: (db: IDBDatabase) => Promise<void>) {
  queue = queue.then(async () => { const db = await open(); if (db) await fn(db); }).catch(() => {
    // Disabled storage and quota errors leave the in-memory session usable.
  });
  return queue;
}
function forget() {
  generation++;
  memory.clear();
  updateStats();
}
export function cacheTicket() { return generation; }
export function cached<T>(key: string): T | undefined {
  return enabled && scope ? memory.get(key)?.value as T | undefined : undefined;
}
export function forgetCached(key:string) {
  memory.delete(key);updateStats();
  return persist(db=>transaction(db,store=>store.delete(key)));
}
export function cachePut(key: string, value: unknown, ticket = generation) {
  if (!enabled || !scope || ticket !== generation) return;
  const row: Row = { key, scope, value, used: Date.now(), bytes: new Blob([JSON.stringify(value)]).size };
  memory.set(key, row);
  const oldest = [...memory.values()].filter(r => threadKey(r.key)).sort((a,b) => b.used - a.used).slice(15);
  for (const r of oldest) memory.delete(r.key);
  updateStats();
  void persist(async db => {
    if (ticket !== generation) return;
    await transaction(db, store => { store.put(row); for (const r of oldest) store.delete(r.key); });
  });
}
export async function authorizeCache(next: string) {
  if (!next || !enabled) { scope = next; return; }
  if (scope === next) return;
  forget();
  scope = next;
  const ticket = generation;
  await persist(async db => {
    // Read only rows belonging to the session verified by the server on this navigation.
    const rows = await new Promise<Row[]>((resolve, reject) => {
      const req = db.transaction("entries").objectStore("entries").getAll();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    if (ticket !== generation) return;
    const foreign: string[] = [];
    for (const row of rows) {
      if (row.scope !== next) foreign.push(row.key);
      else if (!memory.has(row.key)) memory.set(row.key, row);
    }
    updateStats();
    if (foreign.length) await transaction(db, store => { for (const key of foreign) store.delete(key); });
  });
}
export function clearLocalCache(broadcast = true) {
  forget();
  if (broadcast) localStorage.setItem(invalidation, crypto.randomUUID());
  return persist(db => transaction(db, store => { store.clear(); }));
}
export const sessionClosed = "codexdeck.session.closed";
export function closeCacheSession(broadcast=true) {
  if(broadcast && scope)localStorage.setItem(sessionClosed,crypto.randomUUID());
  scope="";return clearLocalCache(broadcast);
}
export function setCacheEnabled(on: boolean) {
  enabled = on;
  localStorage.setItem(preference, String(on));
  if (!on) return clearLocalCache();
  updateStats();
  return Promise.resolve();
}
window.addEventListener("storage", e => {
  if (e.key === preference) { enabled = e.newValue !== "false"; if (!enabled) forget(); else updateStats(); }
  if (e.key === invalidation) forget();
});
export function useCacheStats() {
  return useSyncExternalStore(fn => {listeners.add(fn); return () => listeners.delete(fn);}, () => stats);
}
