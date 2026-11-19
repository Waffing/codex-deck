import { cp, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageDirectory, "../..");
const runtime = path.join(packageDirectory, "runtime");
const copies = [
  ["apps/server/dist", "apps/server/dist"],
  ["apps/web/dist", "apps/web/dist"],
  ["packages/ops-mcp/dist", "packages/ops-mcp/dist"],
  ["packages/shared/dist", "packages/shared/dist"],
];

for (const [source, destination] of copies) {
  const target = path.join(runtime, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(repositoryRoot, source), target, { recursive: true, force: true });
}

await cp(
  path.join(repositoryRoot, "packages/shared/package.json"),
  path.join(runtime, "packages/shared/package.json"),
);

const opsEntry = path.join(runtime, "packages/ops-mcp/dist/index.js");
await rename(opsEntry, path.join(runtime, "packages/ops-mcp/dist/index.original.js"));
await writeFile(opsEntry, 'import "../../../../register-loader.mjs";\nawait import("./index.original.js");\n');
