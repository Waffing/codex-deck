import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { approvalSchema, threadSchema, workspaceSchema } from "@codexdeck/shared";
import { ChatPane } from "./ChatPane";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("移到掌上布局时移除首页已展示的同一张审批卡和它的 Enter 快捷键", async () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const fetcher = vi.fn(async () => Response.json({ tasks: [], artifacts: [] }));
  vi.stubGlobal("fetch", fetcher);
  const time = new Date().toISOString();
  const workspace = workspaceSchema.parse({
    id: "w", name: "测试", path: "/workspace", status: "ready", created_at: time, updated_at: time,
  });
  const thread = threadSchema.parse({
    id: "t", workspace_id: "w", title: "会话", status: "running", active_model_alias: "a",
    reasoning_effort: null, created_at: time, updated_at: time,
  });
  const approval = approvalSchema.parse({
    id: "a", thread_id: "t", payload: {}, action: "test", risk_level: "low", status: "pending",
    created_at: time, resolved_at: null,
  });
  render(<ChatPane workspace={workspace} thread={thread} events={[]} models={[]} providers={[]}
    approvals={[approval]} mobileApprovalId="a" onCreateThread={async () => thread}
    onOpen={() => {}} onRefresh={() => {}} />);
  expect(screen.getByRole("button", {name: "批准本次"})).toBeInTheDocument();
  act(() => {
    media.matches = true;
    media.dispatchEvent(new Event("change"));
  });
  expect(screen.queryByRole("button", {name: "批准本次"})).not.toBeInTheDocument();
  await userEvent.setup().keyboard("{Enter}");
  expect(fetcher).not.toHaveBeenCalledWith("/api/approvals/a/decision", expect.anything());
});
