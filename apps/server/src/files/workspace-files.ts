import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, readdir, realpath, rename, unlink, open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { lookup } from "mime-types";
import type { ChangeType, Workspace, Artifact } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { cloneRepository } from "./git.js";
import { isolatedTracking } from "./isolated-tracking.js";
import { trackingOperations, type TrackingOperation, type TrackingResult } from "./tracking-operations.js";
import { ensureDirectory, fileError, missing, openWorkspaceFile, resolveSafeWorkspacePath, saveWorkspaceFile } from "./sandbox.js";
import { signDownload } from "./signed-url.js";
import type { FileSnapshot } from "./tracker.js";

function isolationKey(root: string) {
  return "executor.isolated.path." + createHash("sha256").update(root).digest("hex");
}

export class WorkspaceFiles {
  private readonly clones = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly activeCheckpoints = new Map<string, string>();
  private readonly hostTracking = new Map<string, Set<Promise<unknown>>>();
  private readonly workspaceRoot: string;
  constructor(private readonly context: ServerContext, private readonly dataDirectory: string,
    private readonly append: (thread: string, type: string, payload: unknown) => unknown, managedWorkspaceDirectory?: string) {
    this.workspaceRoot = managedWorkspaceDirectory ?? path.join(dataDirectory, "workspaces");
    // Upgrade installations whose first isolated sessions predate the path marker.
    const previous = context.native.prepare("SELECT DISTINCT w.path FROM workspaces w JOIN threads t ON t.workspace_id=w.id WHERE t.executor_mode='isolated'").all() as {path:string}[];
    for (const {path: root} of previous) this.storeIsolation(root);
  }

  private storeIsolation(root: string) {
    this.context.native.prepare("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES(?,'1',?)")
      .run(isolationKey(root), new Date().toISOString());
  }

  private isIsolatedRoot(root: string) {
    return !!this.context.native.prepare("SELECT 1 FROM settings WHERE key=?").pluck().get(isolationKey(root));
  }

  async hasIsolatedHistory(workspaceId: string) {
    return this.isIsolatedRoot(await this.getRoot(workspaceId));
  }

  async markIsolatedHistory(workspaceId: string) {
    const root = await this.getRoot(workspaceId);
    this.storeIsolation(root);
    // New operations now dispatch to Docker. Drain previously started host Git
    // before a writable, fully privileged project session can get its mount.
    await Promise.allSettled(this.hostTracking.get(root) ?? []);
  }

  async track<K extends TrackingOperation>(workspaceId: string, operation: K, turnId = ""): Promise<TrackingResult<K>> {
    const root = await this.getRoot(workspaceId);
    if (this.isIsolatedRoot(root)) return isolatedTracking(root, this.dataDirectory, operation, turnId,this.context.native);
    // Synchronous registration with the marker check makes the transition atomic
    // with respect to other requests in this control process.
    const pending = this.hostTracking.get(root) ?? new Set<Promise<unknown>>();
    this.hostTracking.set(root, pending);
    const work = trackingOperations[operation](root, turnId);
    pending.add(work);
    try { return await work as TrackingResult<K>; }
    finally {
      pending.delete(work);
      if (!pending.size) this.hostTracking.delete(root);
    }
  }

  private async managedRoot() {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(this.workspaceRoot);
    if (!(await lstat(root)).isDirectory()) throw fileError(403, "Workspace root must be a directory.");
    return root;
  }

  list(): Workspace[] {
    return this.context.native.prepare("SELECT id,name,path,status,automation_level,created_at,updated_at FROM workspaces ORDER BY created_at, id").all() as Workspace[];
  }

  async availableLocalDirectories() {
    const parent = await this.managedRoot();
    const registered = new Set(this.list().map(workspace=>path.basename(workspace.path)));
    const entries = await readdir(parent,{withFileTypes:true});
    return entries.filter(e=>e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith(".") && !registered.has(e.name))
      .map(e=>e.name).sort();
  }

  async importLocal(input:{directory:string;name?:string;automation_level:Workspace["automation_level"]}) {
    const parent = await this.managedRoot();
    const directory = await resolveSafeWorkspacePath(parent,input.directory);
    const info = await lstat(directory).catch(error => {
      if (missing(error)) throw fileError(404,"Directory not found.");
      throw error;
    });
    if (path.relative(parent,directory)!==input.directory || !info.isDirectory()) throw fileError(403,"Select a managed directory.");
    if (this.list().some(w=>!path.relative(w.path,directory))) throw fileError(409,"Directory already registered.");
    const now = new Date().toISOString();
    return this.context.native.prepare(`INSERT INTO workspaces(id,name,path,automation_level,status,created_at,updated_at)
      VALUES(?,?,?,?,'ready',?,?) RETURNING *`).get(randomUUID(),input.name ?? input.directory,directory,input.automation_level,now,now) as Workspace;
  }

  async create(name: string, level: Workspace["automation_level"], clone?: URL): Promise<Workspace> {
    const id = randomUUID();
    const parent = await this.managedRoot();
    const directory = await ensureDirectory(parent, id);
    const now = new Date().toISOString();
    const row: Workspace = { id, name, path: directory, automation_level: level, status: clone ? "cloning" : "ready", created_at: now, updated_at: now };
    this.context.native.prepare("INSERT INTO workspaces(id,name,path,automation_level,status,created_at,updated_at) VALUES(@id,@name,@path,@automation_level,@status,@created_at,@updated_at)").run(row);
    if (clone) {
      const abort = new AbortController();
      const update = (status: string) => {
        this.context.native.prepare("UPDATE workspaces SET status=?,updated_at=? WHERE id=?").run(status, new Date().toISOString(), id);
      };
      const done = cloneRepository(directory, clone, abort.signal).then(() => update("ready"), () => update("failed"))
        .finally(() => { this.clones.delete(id); });
      this.clones.set(id, { abort, done });
    }
    return row;
  }

  async close() {
    const clones = [...this.clones.values()];
    for (const clone of clones) clone.abort.abort();
    await Promise.all(clones.map(clone => clone.done));
  }

  async unregister(id: string) {
    if (this.activeCheckpoints.has(id)) throw fileError(409, "Workspace has an active turn.");
    const clone = this.clones.get(id);
    if (clone) { clone.abort.abort(); await clone.done; }
    const deleted = this.context.native.prepare("DELETE FROM workspaces WHERE id=?").run(id);
    if (!deleted.changes) throw fileError(404, "Workspace not found.");
  }

  async getRoot(id: string): Promise<string> {
    const row = this.context.native.prepare("SELECT path,status FROM workspaces WHERE id=?").get(id) as Pick<Workspace,"path"|"status"> | undefined;
    if (!row) throw fileError(404, "Workspace not found.");
    if (row.status !== "ready") throw fileError(409, "Workspace is not ready.");
    const parent = await this.managedRoot();
    const relative = path.relative(parent, row.path);
    if (!relative || relative.includes(path.sep) || relative === "..") throw fileError(403, "Invalid workspace root.");
    const expected = path.join(await realpath(parent), relative);
    const actual = await resolveSafeWorkspacePath(parent, relative);
    if (path.relative(expected, actual) || !(await lstat(actual)).isDirectory()) throw fileError(403, "Invalid workspace root.");
    return actual;
  }

  async agentsText(workspaceId: string, scope: "global" | "project"): Promise<string> {
    const workspace = await this.getRoot(workspaceId);
    const root = scope === "global" ? await ensureDirectory(this.dataDirectory, "instructions") : workspace;
    try {
      const handle = await openWorkspaceFile(root, "AGENTS.md");
      try {
        if ((await handle.stat()).size > 1024 * 1024) throw fileError(413, "Instructions exceed the preview limit.");
        return await handle.readFile("utf8");
      } finally { await handle.close(); }
    } catch (error) { if ((error as { statusCode?: number }).statusCode === 404 || missing(error)) return ""; throw error; }
  }

  async saveAgents(workspaceId: string, scope: "global" | "project", content: string) {
    const workspace = await this.getRoot(workspaceId);
    const root = scope === "global" ? await ensureDirectory(this.dataDirectory, "instructions") : workspace;
    if (Buffer.byteLength(content) > 1024 * 1024) throw fileError(413, "Instructions exceed the limit.");
    await saveWorkspaceFile(root, "AGENTS.md", content);
  }

  async instructionRoot(workspaceId:string, scope:"global"|"project") {
    const workspace = await this.getRoot(workspaceId);
    return scope === "global" ? ensureDirectory(this.dataDirectory,"instructions") : workspace;
  }

  async registerArtifact(workspaceId: string, threadId: string | null, turnId: string | null, relativePath: string, changeType: ChangeType): Promise<Artifact> {
    const root = await this.getRoot(workspaceId);
    const target = await resolveSafeWorkspacePath(root, relativePath);
    const dataRoot=await realpath(this.dataDirectory);
    const directory = await ensureDirectory(dataRoot, "artifact-blobs");
    if(directory!==path.join(dataRoot,"artifact-blobs"))throw fileError(403,"Invalid snapshot directory.");
    const temporary = await resolveSafeWorkspacePath(directory, "capture-" + randomUUID());
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const handle = await openWorkspaceFile(root, relativePath);
    try {
      const output = await open(temporary, "wx", 0o600);
      try {
        await pipeline(handle.createReadStream(), new Transform({
          transform(chunk, _encoding, done) { sizeBytes+=chunk.length; hash.update(chunk); done(null,chunk); },
        }), output.createWriteStream());
      } finally { await output.close(); }
    } catch (error) {
      await unlink(temporary).catch(e=>{if (!missing(e)) throw e;});
      throw error;
    } finally { await handle.close(); }
    const digest = hash.digest("hex");
    try {
      const destination=await resolveSafeWorkspacePath(directory,digest);
      if(destination!==path.join(directory,digest))throw fileError(403,"Invalid snapshot path.");
      await rename(temporary,destination);
    }
    finally { await unlink(temporary).catch(e=>{if (!missing(e)) throw e;}); }
    if (threadId && !this.context.native.prepare("SELECT 1 FROM threads WHERE id=? AND workspace_id=?").get(threadId, workspaceId)) {
      throw fileError(403, "Thread does not belong to this workspace.");
    }
    const rel = path.relative(root, target).split(path.sep).join("/");
    const row: Artifact = { id: randomUUID(), workspace_id: workspaceId, thread_id: threadId, turn_id: turnId,
      name: path.basename(target), path: rel, mime_type: lookup(target) || "application/octet-stream",
      change_type: changeType, size_bytes:sizeBytes, created_at: new Date().toISOString() };
    this.context.native.prepare("INSERT INTO artifacts(id,workspace_id,thread_id,turn_id,name,path,mime_type,change_type,created_at,content_sha256,size_bytes) VALUES(@id,@workspace_id,@thread_id,@turn_id,@name,@path,@mime_type,@change_type,@created_at,@digest,@size_bytes)").run({...row,digest});
    return row;
  }

  async backfillArtifactSizes(turnIds:string[]) {
    const read=this.context.native.prepare("SELECT id,content_sha256 FROM artifacts WHERE turn_id=? AND size_bytes IS NULL AND content_sha256 IS NOT NULL");
    const store=this.context.native.prepare("UPDATE artifacts SET size_bytes=? WHERE id=? AND size_bytes IS NULL");
    for (const turnId of turnIds) {
      for (const row of read.all(turnId) as {id:string;content_sha256:string}[]) {
        if (!/^[0-9a-f]{64}$/.test(row.content_sha256)) continue;
        try {
          const file=await this.openSnapshot(row.content_sha256);
          try {store.run((await file.stat()).size,row.id);} finally {await file.close();}
        } catch(error) {if((error as {statusCode?:number}).statusCode!==410) throw error;}
      }
    }
  }

  async openArtifact(id:string) {
    const digest = this.context.native.prepare("SELECT content_sha256 FROM artifacts WHERE id=?").pluck().get(id);
    return this.openSnapshot(digest);
  }

  async openSnapshot(digest:unknown) {
    const gone=()=>fileError(410,"No archived version of this artifact is available.");
    if(typeof digest!=="string" || !/^[0-9a-f]{64}$/.test(digest)) throw gone();
    const root=await realpath(this.dataDirectory);
    const relative="artifact-blobs/"+digest;
    if(await resolveSafeWorkspacePath(root,relative)!==path.join(root,relative)) throw fileError(403,"Invalid snapshot path.");
    try {return await openWorkspaceFile(path.join(root,"artifact-blobs"),digest);}
    catch(error){if(missing(error)||(error as {statusCode?:number}).statusCode===404)throw gone();throw error;}
  }

  async beforeTurn(workspaceId: string, threadId: string, turnId: string): Promise<FileSnapshot> {
    if (this.activeCheckpoints.has(workspaceId)) throw fileError(409, "Workspace has an active turn.");
    this.activeCheckpoints.set(workspaceId, turnId);
    try {
      const { entries, ref } = await this.track(workspaceId, "before", turnId);
      if (ref) this.context.native.prepare("INSERT INTO checkpoints(turn_id,workspace_id,thread_id,ref,created_at) VALUES(?,?,?,?,?)")
        .run(turnId, workspaceId, threadId, ref, new Date().toISOString());
      return new Map(entries);
    } catch (error) { this.activeCheckpoints.delete(workspaceId); throw error; }
  }

  async afterTurn(workspaceId: string, threadId: string, turnId: string, previous: FileSnapshot): Promise<Artifact[]> {
    try {
      const { entries, changes } = await this.track(workspaceId, "after", turnId);
      const current = new Map(entries);
      const artifacts = this.context.native.prepare("SELECT * FROM artifacts WHERE workspace_id=? AND thread_id=? AND turn_id=?")
        .all(workspaceId,threadId,turnId) as Artifact[];
      const registered = new Set(artifacts.map(item=>item.path));
      for (const [name, fingerprint] of current) {
        if (!registered.has(name) && previous.get(name) !== fingerprint) {
          artifacts.push(await this.registerArtifact(workspaceId, threadId, turnId, name, previous.has(name) ? "modified" : "added"));
        }
      }
      const recorded=this.context.native.prepare("SELECT turn_diff_json FROM tasks WHERE id=?").pluck().get(turnId);
      if (changes || !recorded) {
        const all=new Set([...current.keys(),...previous.keys()]);
        const fallback=[...all].filter(name=>current.get(name)!==previous.get(name)).map(path=>({path,added:null,removed:null}));
        this.context.native.prepare("UPDATE tasks SET turn_diff_json=? WHERE id=?").run(JSON.stringify(this.context.masker.maskObject(changes??{files:fallback,diff:""})),turnId);
      }
      await this.append(threadId, "artifacts_updated", { turn_id: turnId, artifacts });
      return artifacts;
    } finally { this.activeCheckpoints.delete(workspaceId); }
  }

  async restore(workspaceId: string, requestedRef: string) {
    const turnId = requestedRef.replace(/^refs\/codexdeck\/checkpoints\//, "");
    const row = this.context.native.prepare("SELECT thread_id FROM checkpoints WHERE workspace_id=? AND turn_id=?").get(workspaceId, turnId) as { thread_id: string } | undefined;
    if (!row) throw fileError(404, "Checkpoint not found.");
    if (this.activeCheckpoints.has(workspaceId)) throw fileError(409, "Workspace has an active turn.");
    this.activeCheckpoints.set(workspaceId, turnId);
    try {
      await this.track(workspaceId, "restore", turnId);
      await this.append(row.thread_id, "checkpoint_restored", { turn_id: turnId });
    } finally { this.activeCheckpoints.delete(workspaceId); }
  }

  artifactsFor(subject: { kind: "artifact" | "turn"; id: string }): Artifact[] {
    const query = subject.kind === "artifact" ? "id=?" : "turn_id=?";
    const rows = this.context.native.prepare("SELECT * FROM artifacts WHERE " + query + " ORDER BY created_at,id").all(subject.id) as Artifact[];
    if (!rows.length) throw fileError(404, "No artifacts found.");
    return rows;
  }

  signArtifact(id: string, ttlSeconds?: number): string {
    this.artifactsFor({ kind: "artifact", id });
    return signDownload({ kind: "artifact", id }, this.context.masterKey, ttlSeconds);
  }
}
