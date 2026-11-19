import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Approval } from "@codexdeck/shared";
import { ApprovalCard } from "./ApprovalCard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(risk: Approval["risk_level"] = "medium") {
  const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetcher);
  const approval: Approval & { expires_at: string } = {
    id: "req1",
    thread_id: "t",
    payload: { command: "pnpm test" },
    action: "item/commandExecution/requestApproval",
    risk_level: risk,
    status: "pending",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 120000).toISOString(),
    resolved_at: null,
  };
  render(<ApprovalCard approval={approval} workspaceName="Workspace" onResolved={() => {}} shortcut />);
  return { fetcher, user: userEvent.setup() };
}
it.each([
  ["批准本次", "approve"],
  ["本会话同类放行", "approve_session"],
  ["中止任务", "abort"],
])("提交内嵌审批：%s", async (label, decision) => {
  const { fetcher, user } = setup();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(fetcher).toHaveBeenCalledWith(
      "/api/approvals/req1/decision",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ decision }) }),
    ),
  );
});
it("仅在卡内提交非空纠偏意见后拒绝", async () => {
  const { fetcher, user } = setup();
  await user.click(screen.getByRole("button", { name: "拒绝并给指令" }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "提交纠偏" })).toBeDisabled();
  await user.type(screen.getByRole("textbox", { name: "纠偏指令" }), "先检查测试范围{Enter}");
  expect(fetcher).toHaveBeenCalledWith(
    "/api/approvals/req1/decision",
    expect.objectContaining({
      body: JSON.stringify({ decision: "deny_guide", user_guidance: "先检查测试范围" }),
    }),
  );
});
it("高风险先确认再批准，防止一次 Enter 直接执行", async () => {
  const { fetcher, user } = setup("high");
  await user.keyboard("{Enter}");
  expect(fetcher).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "确认批准本次" }));
  expect(fetcher).toHaveBeenCalledTimes(1);
});
