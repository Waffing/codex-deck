import path from "node:path";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const fileError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function segments(input: string) {
  if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || input.includes(":")) throw fileError(403, "Absolute path refused.");
  const components = input.split(/[\\/]/).filter(part => part && part !== ".");
  for (const component of components) {
    // Include Windows device names, ADS and ambiguous trailing dots on every host.
    if (component === ".." || /[\x00-\x1f<>:"|?*]/.test(component) || /[. ]$/.test(component)
      || /^(?:\.git|\.codexdeck|git~[1-9][0-9]*)$/i.test(component)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(component)) throw fileError(403, "Unsafe workspace path.");
  }
  return components;
}

export async function resolveSafeWorkspacePath(workspaceRoot: string, relPath: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const parts = segments(relPath);
  let current = root;
  for (const [index, part] of parts.entries()) {
    const candidate = path.join(current, part);
    let info;
    try { info = await lstat(candidate); } catch (error) {
      if (!missing(error)) throw error;
      return path.join(candidate, ...parts.slice(index + 1));
    }
    try { current = await realpath(candidate); } catch (error) {
      if (info.isSymbolicLink()) throw fileError(403, "Unresolvable workspace link.");
      throw error;
    }
    segments(path.relative(root, current));
  }
  return current;
}

export async function ensureDirectory(root: string, relative: string): Promise<string> {
  const directory = await resolveSafeWorkspacePath(root, relative);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return resolveSafeWorkspacePath(root, relative);
}

export async function openWorkspaceFile(root: string, relative: string) {
  const target = await resolveSafeWorkspacePath(root, relative);
  const info = await lstat(target).catch(error => { if (missing(error)) throw fileError(404, "File not found."); throw error; });
  if (!info.isFile() || info.nlink !== 1) throw fileError(403, "Expected a regular workspace file.");
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await file.stat();
    if (opened.ino !== info.ino || opened.dev !== info.dev || opened.nlink !== 1
      || (await resolveSafeWorkspacePath(root, relative)) !== target) throw fileError(403, "File changed during access.");
    return file;
  } catch (error) { await file.close(); throw error; }
}

export async function saveWorkspaceFile(root: string, relative: string, data: string | Buffer) {
  const target = await resolveSafeWorkspacePath(root, relative);
  if (target === await realpath(root)) throw fileError(403, "Expected a file.");
  const dir = await ensureDirectory(root, path.relative(root, path.dirname(target)));
  const tempRel = path.relative(root, path.join(dir, ".codex-write-" + randomUUID()));
  const temp = await resolveSafeWorkspacePath(root, tempRel);
  let mode = 0o600;
  try {
    const existing = await lstat(target);
    if (!existing.isFile() || existing.nlink !== 1) throw fileError(403, "Expected a regular workspace file.");
    mode = existing.mode;
  } catch (error) { if (!missing(error)) throw error; }
  await writeFile(temp, data, { flag: "wx", mode });
  try {
    await rename(await resolveSafeWorkspacePath(root, tempRel), await resolveSafeWorkspacePath(root, relative));
  } finally {
    await unlink(await resolveSafeWorkspacePath(root, tempRel)).catch(error => { if (!missing(error)) throw error; });
  }
}

export const ignored = new Set([".git", ".codexdeck", "node_modules", ".venv", "__pycache__"]);
