import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import path from "node:path";

const cli = fileURLToPath(new URL("../bin/codex-deck.mjs", import.meta.url));

test("help prints supported commands without requiring a server", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /start .*--port/);
  assert.match(result.stdout, /status/);
  assert.match(result.stdout, /doctor/);
});

test("start rejects protected and malformed ports before launching a process", () => {
  for (const port of ["80", "443", "22", "0", "nope"]) {
    const result = spawnSync(process.execPath, [cli, "start", "--port", port], { encoding: "utf8" });
    assert.equal(result.status, 1, port);
    assert.match(result.stderr, /Port must be/);
  }
});

test("start rejects unknown options", () => {
  const result = spawnSync(process.execPath, [cli, "start", "--unknown", "x"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown option/);
});

test("status reads the unauthenticated health document", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", version: "0.1.0", uptime: 12 }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const child = spawn(process.execPath, [cli, "status", "--url", `http://127.0.0.1:${address.port}`]);
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.match(output, /version 0\.1\.0/);
    assert.match(output, /uptime 12s/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
