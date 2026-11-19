import path from "node:path";
import { lstat, readdir } from "node:fs/promises";
import { indexedPaths } from "./git.js";
import { ignored, missing, resolveSafeWorkspacePath } from "./sandbox.js";

export type FileSnapshot = Map<string, string>;
export async function snapshotFiles(root: string): Promise<FileSnapshot> {
  const files: FileSnapshot = new Map();
  async function record(name: string) {
    const target = await resolveSafeWorkspacePath(root, name);
    const stat = await lstat(target, { bigint: true }).catch(error => { if (missing(error)) return null; throw error; });
    if (stat?.isFile() && stat.nlink === 1n) files.set(name, [stat.size, stat.mtimeNs, stat.ctimeNs, stat.ino].join("/"));
  }
  const indexed = await indexedPaths(root);
  if (indexed) {
    for (const name of indexed) {
      if (!name.split("/").some(part => ignored.has(part.toLowerCase()))) await record(name);
    }
    return files;
  }
  async function walk(relative: string) {
    const dir = await resolveSafeWorkspacePath(root, relative);
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await walk(name);
      else await record(name);
    }
  }
  await walk("");
  return files;
}
