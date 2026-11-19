import { link, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { schema } from "./schema.js";
import { runMigrations } from "./migrations.js";
import { repositoryRoot, workspaceDirectory, workspaceFile } from "../security/paths.js";

export type CodexDeckDatabase = BetterSQLite3Database<typeof schema>;

export function resolveDataDirectory(configuredPath?: string, workspaceRoot = repositoryRoot): Promise<string> {
  const configured = configuredPath ?? process.env.CODEXDECK_DATA_DIR ?? ".codexdeck";
  if (!path.isAbsolute(configured)) return workspaceDirectory(workspaceRoot, configured, true);
  return mkdir(configured, { recursive: true, mode: 0o700 }).then(() => realpath(configured));
}

export async function openDatabase(dataDirectory: string, workspaceRoot = repositoryRoot): Promise<{
  native: Database.Database;
  orm: CodexDeckDatabase;
  path: string;
}> {
  const dataRoot = path.isAbsolute(dataDirectory) ? path.dirname(dataDirectory) : workspaceRoot;
  const directory = await workspaceDirectory(dataRoot, dataDirectory);
  const databasePath = await workspaceFile(dataRoot, path.join(directory, "codexdeck.sqlite"));
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await workspaceFile(dataRoot, databasePath + suffix);
  }
  const native = new Database(databasePath);
  try {
    native.pragma("foreign_keys = ON");
    native.pragma("journal_mode = WAL");
    runMigrations(native);
    return { native, orm: drizzle(native, { schema }), path: databasePath };
  } catch (error) {
    native.close();
    throw error;
  }
}

export async function readOrCreateFileKey(dataDirectory: string, workspaceRoot = repositoryRoot): Promise<Buffer> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set CODEXDECK_MASTER_KEY before starting a production server.");
  }
  const dataRoot = path.isAbsolute(dataDirectory) ? path.dirname(dataDirectory) : workspaceRoot;
  const directory = await workspaceDirectory(dataRoot, dataDirectory);
  const keyPath = path.join(directory, "master.key");
  async function readPersistedKey(): Promise<Buffer> {
    const content = (await readFile(await workspaceFile(dataRoot, keyPath), "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(content)) throw new Error("The persisted CodexDeck master key is invalid.");
    return Buffer.from(content, "hex");
  }
  try {
    return await readPersistedKey();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Publish a complete file atomically. An overlapping startup reads the winning key.
  const temp = await workspaceFile(dataRoot, path.join(directory, randomUUID() + ".key.tmp"));
  const key = randomBytes(32);
  await writeFile(temp, key.toString("hex"), { flag: "wx", mode: 0o600, flush: true });
  try {
    await link(await workspaceFile(dataRoot, temp), await workspaceFile(dataRoot, keyPath));
    console.warn("Generated a local CodexDeck master.key in the data directory. Set CODEXDECK_MASTER_KEY to manage it explicitly.");
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return await readPersistedKey();
  } finally {
    await unlink(await workspaceFile(dataRoot, temp));
  }
}
