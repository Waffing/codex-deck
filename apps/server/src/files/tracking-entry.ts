import { trackingOperations, type TrackingOperation } from "./tracking-operations.js";

const [, , operation, turnId = ""] = process.argv;
if (!Object.hasOwn(trackingOperations, operation)) throw new Error("Unknown tracking operation.");
try {
  const result = await trackingOperations[operation as TrackingOperation]("/workspace", turnId);
  process.stdout.write(JSON.stringify({ result }));
} catch (error) {
  const code = (error as { statusCode?: number }).statusCode;
  // Git stderr may contain file contents or arbitrary repository text.
  process.stdout.write(JSON.stringify({ error: code === 403 || code === 404 || code === 409 ? code : 500 }));
}
