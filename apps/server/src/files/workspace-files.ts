import { randomUUID } from "node:crypto";
import path from "node:path";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { lookup } from "mime-types";
import type { ChangeType, Workspace, Artifact } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { cloneRepository, createCheckpoint, restoreCheckpoint } from "./git.js";
import { ensureDirectory, fileError, missing, openWorkspaceFile, resolveSafeWorkspacePath, saveWorkspaceFile } from "./sandbox.js";
import { signDownload } from "./signed-url.js";
import { snapshotFiles, type FileSnapshot } from "./tracker.js";

export class WorkspaceFiles {
  private readonly clones = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private readonly activeCheckpoints = new Map<string, string>();
  private readonly workspaceRoot: string;
  constructor(private readonly context: ServerContext, private readonly dataDirectory: string,
    private readonly append: (thread: string, type: string, payload: unknown) => unknown, managedWorkspaceDirectory?: string) {
    this.workspaceRoot = managedWorkspaceDirectory ?? path.join(dataDirectory, "workspaces");
  }

  private async managedRoot() {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(this.workspaceRoot);
    if (!(await lstat(root)).isDirectory()) throw fileError(403, "Workspace root must be a directory.");
    return root;
  }

  list(): Workspace[] {
    return this.context.native.prepare("SELECT * FROM workspaces ORDER BY created_at, id").all() as Workspace[];
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

  async registerArtifact(workspaceId: string, threadId: string | null, turnId: string | null, relativePath: string, changeType: ChangeType): Promise<Artifact> {
    const root = await this.getRoot(workspaceId);
    const target = await resolveSafeWorkspacePath(root, relativePath);
    const handle = await openWorkspaceFile(root, relativePath);
    await handle.close();
    if (threadId && !this.context.native.prepare("SELECT 1 FROM threads WHERE id=? AND workspace_id=?").get(threadId, workspaceId)) {
      throw fileError(403, "Thread does not belong to this workspace.");
    }
    const rel = path.relative(root, target).split(path.sep).join("/");
    const row: Artifact = { id: randomUUID(), workspace_id: workspaceId, thread_id: threadId, turn_id: turnId,
      name: path.basename(target), path: rel, mime_type: lookup(target) || "application/octet-stream",
      change_type: changeType, created_at: new Date().toISOString() };
    this.context.native.prepare("INSERT INTO artifacts(id,workspace_id,thread_id,turn_id,name,path,mime_type,change_type,created_at) VALUES(@id,@workspace_id,@thread_id,@turn_id,@name,@path,@mime_type,@change_type,@created_at)").run(row);
    return row;
  }

  async beforeTurn(workspaceId: string, threadId: string, turnId: string): Promise<FileSnapshot> {
    const root = await this.getRoot(workspaceId);
    if (this.activeCheckpoints.has(workspaceId)) throw fileError(409, "Workspace has an active turn.");
    this.activeCheckpoints.set(workspaceId, turnId);
    try {
      const snapshot = await snapshotFiles(root);
      const ref = await createCheckpoint(root, turnId);
      if (ref) this.context.native.prepare("INSERT INTO checkpoints(turn_id,workspace_id,thread_id,ref,created_at) VALUES(?,?,?,?,?)")
        .run(turnId, workspaceId, threadId, ref, new Date().toISOString());
      return snapshot;
    } catch (error) { this.activeCheckpoints.delete(workspaceId); throw error; }
  }

  async afterTurn(workspaceId: string, threadId: string, turnId: string, previous: FileSnapshot): Promise<Artifact[]> {
    try {
      const root = await this.getRoot(workspaceId);
      const current = await snapshotFiles(root);
      const artifacts = this.context.native.prepare("SELECT * FROM artifacts WHERE workspace_id=? AND thread_id=? AND turn_id=?")
        .all(workspaceId,threadId,turnId) as Artifact[];
      const registered = new Set(artifacts.map(item=>item.path));
      for (const [name, fingerprint] of current) {
        if (!registered.has(name) && previous.get(name) !== fingerprint) {
          artifacts.push(await this.registerArtifact(workspaceId, threadId, turnId, name, previous.has(name) ? "modified" : "added"));
        }
      }
      await this.append(threadId, "artifacts_updated", { turn_id: turnId, artifacts });
      return artifacts;
    } finally { this.activeCheckpoints.delete(workspaceId); }
  }

  async restore(workspaceId: string, requestedRef: string) {
    const root = await this.getRoot(workspaceId);
    const turnId = requestedRef.replace(/^refs\/codexdeck\/checkpoints\//, "");
    const row = this.context.native.prepare("SELECT thread_id FROM checkpoints WHERE workspace_id=? AND turn_id=?").get(workspaceId, turnId) as { thread_id: string } | undefined;
    if (!row) throw fileError(404, "Checkpoint not found.");
    if (this.activeCheckpoints.has(workspaceId)) throw fileError(409, "Workspace has an active turn.");
    this.activeCheckpoints.set(workspaceId, turnId);
    try {
      await restoreCheckpoint(root, turnId);
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
