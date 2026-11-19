import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// src/security and dist/security are at the same depth in the workspace.
export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function relativeChild(root: string, target: string): string {
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Path must be strictly inside the configured workspace.");
  }
  return relative;
}

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

/** Resolve every ancestor before creating anything under it, including on a cold start. */
export async function workspaceDirectory(workspaceRoot: string, target: string, create = false): Promise<string> {
  const root = await realpath(workspaceRoot);
  const relative = relativeChild(path.resolve(workspaceRoot), path.resolve(workspaceRoot, target));
  let directory = root;
  for (const component of relative.split(path.sep)) {
    const next = path.join(directory, component);
    if (create) {
      try {
        await mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
      }
    }
    directory = await realpath(next);
    relativeChild(root, directory);
    if (!(await lstat(directory)).isDirectory()) throw new Error("Expected a workspace directory.");
  }
  return directory;
}

/** SQLite resolves auxiliary names itself, so reject links at all file leaves. */
export async function workspaceFile(workspaceRoot: string, target: string): Promise<string> {
  const parent = await workspaceDirectory(workspaceRoot, path.dirname(target));
  const file = path.join(parent, path.basename(target));
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return file;
    throw error;
  }
  if (!metadata.isFile()) throw new Error("Expected a regular workspace file.");
  const resolved = await realpath(file);
  relativeChild(await realpath(workspaceRoot), resolved);
  return resolved;
}
