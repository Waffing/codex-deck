import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { executorRuntime, projectMountSource } from "../codex/isolated-runner.js";
import { command } from "../server-ops/probe.js";
import { fileError } from "./sandbox.js";
import type { TrackingOperation, TrackingResult } from "./tracking-operations.js";

const exec = promisify(execFile);

export function trackingContainerArgs(options: {
  source: string; image: string; name: string; user: string; operation: TrackingOperation; turnId: string;
}) {
  const { source, image, name, user, operation, turnId } = options;
  if (/[,"\r\n]/.test(source)) throw fileError(400, "Unsupported Docker mount path.");
  const write = operation === "before" || operation === "after" || operation === "restore";
  return ["run", "--rm", "--init", "--pull", "never", "--name", name, "--network", "none", "--read-only",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", user,
    "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpus", "1", "--no-healthcheck",
    "--tmpfs", "/tmp:size=32m,mode=1777", "--env", "HOME=/tmp",
    "--mount", "type=bind,src=" + source + ",dst=/workspace" + (write ? "" : ",readonly"),
    "--entrypoint", "node", image, "/app/apps/server/dist/files/tracking-entry.js", operation, turnId];
}

export async function isolatedTracking<K extends TrackingOperation>(root: string, data: string, operation: K, turnId: string): Promise<TrackingResult<K>> {
  const { id, mounts } = await executorRuntime();
  const name = "codexdeck-files-" + randomUUID();
  const args = trackingContainerArgs({ source: projectMountSource(root, await realpath(data), mounts), image: id, name,
    user: process.getuid!() + ":" + process.getgid!(), operation, turnId });
  let stdout: string;
  try {
    ({ stdout } = await exec("docker", args, { env: { PATH: process.env.PATH, DOCKER_HOST: process.env.DOCKER_HOST },
      timeout: 120_000, maxBuffer: 32 * 1024 * 1024 }));
  } catch {
    // Killing the local CLI on timeout doesn't necessarily stop the container.
    await command("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(() => {});
    throw fileError(503, "Isolated workspace tracking failed.");
  }
  const response = JSON.parse(stdout);
  if (!Object.hasOwn(response, "result")) throw fileError([403, 404, 409].includes(response.error) ? response.error : 500, "Workspace tracking failed.");
  return response.result;
}
