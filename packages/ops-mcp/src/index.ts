import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { opsTools, type OpsTool } from "@codexdeck/shared";

const base = new URL(process.env.CODEXDECK_OPS_URL ?? "");
if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || !base.port || base.username || base.password || base.search || base.hash) {
  throw new Error("A loopback ops endpoint is required.");
}
const token = process.env.CODEXDECK_OPS_TOKEN;
if (!token) throw new Error("Missing scoped ops token.");
const server = new McpServer({ name: "codexdeck-ops", version: "0.2.0" });
const descriptions = {
  server_inspect: "Read this server's runtime, capacity and port inventory.",
  port_allocate: "Lease a loopback staging port for this workspace for one minute.",
  app_deploy_staging: "Stage an immutable static release or a container image for this workspace.",
  app_logs: "Read recent masked deployment logs.", verify_url: "Check the HTTP path, logs and optionally desktop and mobile browsers on a managed deployment.",
  app_promote_live: "Switch the workspace live route and verify it, rolling back on failure.",
  app_rollback: "Restore the preceding deployment snapshot.",
};
for (const name of Object.keys(opsTools) as OpsTool[]) {
  server.registerTool(name, { description: descriptions[name], inputSchema: opsTools[name].shape }, async (args: Record<string, unknown>) => {
    const response = await fetch(new URL("/internal/ops/" + name, base), {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify(args), redirect: "error",
    });
    const result = await response.json();
    return { isError: !response.ok, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  });
}
await server.connect(new StdioServerTransport());
