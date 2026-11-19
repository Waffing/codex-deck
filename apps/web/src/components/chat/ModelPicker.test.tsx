import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { providerSchema, modelSchema, threadSchema, workspaceSchema } from "@codexdeck/shared";
import { ModelPicker } from "./ModelPicker";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const provider = providerSchema.parse({
    id: "p",
    name: "本地中转",
    preset: "custom",
    base_url: "http://localhost:1234",
    api_key_masked: null,
    headers: {},
    quirks: { strip_reasoning: false },
    enabled: true,
    created_at: "",
    updated_at: "",
    last_probe: {
      provider_id: "p",
      ok: true,
      models: ["a"],
      checked_at: "",
      capabilities: { responses: false, chat: true, tools: true, vision: true, latency_ms: 10 },
    },
  });
  const model = modelSchema.parse({
    id: "m",
    provider_id: "p",
    alias: "local-chat",
    model_id: "upstream",
    protocol: "auto",
    fallback_model_ids: [],
    enabled: true,
    cost_input_usd_per_million: 0,
    cost_output_usd_per_million: 0,
    created_at: "",
    updated_at: "",
  });
  const thread = threadSchema.parse({
    id: "t",
    workspace_id: "w",
    title: "t",
    status: "running",
    active_model_alias: "a",
    reasoning_effort: null,
    created_at: "",
    updated_at: "",
  });
  const workspace = workspaceSchema.parse({
    id: "w",
    name: "w",
    path: "/test",
    status: "ready",
    created_at: "",
    updated_at: "",
  });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(thread)));
  vi.stubGlobal("fetch", fetcher);
  const onRefresh = vi.fn(),
    onCreateThread = vi.fn(async () => thread);
  render(
    <ModelPicker
      {...{ workspace, thread, onRefresh, onCreateThread }}
      models={[model]}
      providers={[provider]}
    />,
  );
  return { fetcher, onRefresh, onCreateThread, user: userEvent.setup() };
}
it("按渠道和实测能力选模型，在原会话发 PATCH", async () => {
  const { fetcher, onRefresh, onCreateThread, user } = setup();
  await user.click(screen.getByRole("button", { name: "模型与策略" }));
  ["本地中转", "Tools", "Vision", "Chat转译"].forEach((s) => expect(screen.getByText(s)).toBeInTheDocument());
  await user.click(screen.getByRole("button", { name: /local-chat/ }));
  expect(fetcher).toHaveBeenCalledWith(
    "/api/threads/t/model",
    expect.objectContaining({ method: "PATCH", body: JSON.stringify({ model_alias: "local-chat" }) }),
  );
  expect(onCreateThread).not.toHaveBeenCalled();
  expect(onRefresh).toHaveBeenCalled();
});
it("在相同运行会话更新思考深度", async () => {
  const { fetcher, user } = setup();
  await user.click(screen.getByRole("button", { name: "模型与策略" }));
  await user.selectOptions(screen.getByLabelText("思考深度"), "high");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/threads/t/model",
    expect.objectContaining({ body: JSON.stringify({ reasoning_effort: "high" }) }),
  );
});
