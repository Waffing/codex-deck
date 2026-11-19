import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
const sharedEntry = pathToFileURL(path.join(packageDirectory, "runtime/packages/shared/dist/index.js")).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@codexdeck/shared") return { url: sharedEntry, shortCircuit: true };
  return nextResolve(specifier, context);
}
