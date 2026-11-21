import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, realpath, unlink } from "node:fs/promises";
const devNull = "/dev/null"; // Git for Windows accepts its POSIX null device.
import path from "node:path";
import { promisify } from "node:util";
import { fileError, missing } from "./sandbox.js";

const exec = promisify(execFile);
const common = ["-c", "core.hooksPath=" + devNull, "-c", "core.fsmonitor=false", "-c", "diff.external=", "-c", "credential.helper=", "-c", "core.autocrlf=false"];
function gitEnv() {
  return {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "CodexDeck", GIT_AUTHOR_EMAIL: "checkpoint@localhost",
    GIT_COMMITTER_NAME: "CodexDeck", GIT_COMMITTER_EMAIL: "checkpoint@localhost",
  };
}

export async function cloneRepository(root: string, address: URL, signal: AbortSignal) {
  if (address.protocol !== "https:" || address.username || address.password || address.search || address.hash) {
    throw fileError(400, "Expected an HTTPS Git repository URL without credentials.");
  }
  await exec("git", [...common, "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "http.followRedirects=false",
    "clone", "--no-recurse-submodules", "--", address.href, "."], {
    cwd: await realpath(root), env: { ...gitEnv(), GIT_SSL_CAINFO: process.env.GIT_SSL_CAINFO }, windowsHide: true, signal, timeout: 120000,
  });
}

async function gitDirectory(root: string) {
  const git = path.join(await realpath(root), ".git");
  let info;
  try { info = await lstat(git); } catch (error) { if (missing(error)) return null; throw error; }
  if (!info.isDirectory() || path.relative(git, await realpath(git))) throw fileError(403, "External Git metadata is not allowed.");
  return git;
}

async function run(root: string, args: string[], index?: string) {
  const dir = await gitDirectory(root);
  if (!dir) throw fileError(409, "Workspace has no Git repository.");
  const { stdout } = await exec("git", [...common, ...args], {
    cwd: root, env: { ...gitEnv(), GIT_DIR: dir, GIT_WORK_TREE: root, GIT_OPTIONAL_LOCKS: "0", ...(index && { GIT_INDEX_FILE: index }) },
    maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 60000,
  });
  return stdout;
}

export async function indexedPaths(root: string): Promise<string[] | null> {
  if (!(await gitDirectory(root))) return null;
  const list = await run(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return list.split("\0").filter(Boolean);
}

export async function gitStatus(root: string) {
  return { porcelain: await run(root, ["status", "--porcelain=v1", "--untracked-files=normal"]) };
}

export async function gitDiff(root: string) {
  if (!(await gitDirectory(root))) return "";
  const opts = ["--binary", "--no-ext-diff", "--no-textconv"];
  const head = await run(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "");
  return head ? run(root, ["diff", ...opts, "HEAD", "--"])
    : (await run(root, ["diff", ...opts, "--cached", "--"])) + (await run(root, ["diff", ...opts, "--"]));
}

async function withIndex<T>(root: string, work: (idx: string) => Promise<T>) {
  const git = await gitDirectory(root);
  if (!git) throw fileError(409, "Expected a Git repository.");
  const index = path.join(git, "codexdeck-index-" + randomUUID());
  try {
    // Copy the worktree into a private index, including staged ignored files.
    const source = path.join(git, "index");
    try {
      if (path.relative(source, await realpath(source))) throw fileError(403, "External Git index refused.");
      await copyFile(source, index);
    } catch (error) {
      if (!missing(error)) throw error;
      await run(root, ["read-tree", "--empty"], index);
    }
    await run(root, ["add", "-A", "--", "."], index);
    return await work(index);
  } finally {
    await unlink(index).catch(error => { if (!missing(error)) throw error; });
  }
}

function checkpointRef(turnId: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(turnId)) throw fileError(400, "Invalid checkpoint ID.");
  return "refs/codexdeck/checkpoints/" + turnId;
}

export async function createCheckpoint(root: string, turnId: string) {
  if (!(await gitDirectory(root))) return null;
  const ref = checkpointRef(turnId);
  return withIndex(root, async index => {
    const tree = (await run(root, ["write-tree"], index)).trim();
    const head = (await run(root, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim();
    const commit = (await run(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Before turn " + turnId], index)).trim();
    await run(root, ["update-ref", ref, commit, ""], index);
    return ref;
  });
}

export async function restoreCheckpoint(root: string, turnId: string) {
  const ref = checkpointRef(turnId);
  await withIndex(root, index => run(root, ["read-tree", "--reset", "-u", ref], index));
}

export async function checkpointDiff(root:string,turnId:string) {
  if (!(await gitDirectory(root))) return null;
  const ref=checkpointRef(turnId);
  return withIndex(root,async index=>{
    const options=["diff","--cached","--no-ext-diff","--no-textconv","--no-renames"];
    const stats=await run(root,[...options,"--numstat","-z",ref,"--"],index);
    const files=stats.split("\0").filter(Boolean).map(line=>{
      const [plus,minus,...name]=line.split("\t");
      return {path:name.join("\t"),added:plus==="-"?null:Number(plus),removed:minus==="-"?null:Number(minus)};
    });
    let diff:string;
    try {diff=await run(root,[...options,ref,"--"],index);}
    catch(error) {
      if((error as NodeJS.ErrnoException).code!=="ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw error;
      diff="Patch exceeds the preview size limit.";
    }
    return {files,diff:diff.slice(0,256*1024)};
  });
}
