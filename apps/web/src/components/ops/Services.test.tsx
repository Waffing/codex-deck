import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Services } from "./Services";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("提交指定的上线验收条件，展示上次验收的失败项与截图", async () => {
  const post = vi.fn();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (init?.method === "POST") { post(JSON.parse(String(init.body))); return Response.json({}); }
    if (url === "/api/server/profile") return Response.json(null);
    return Response.json([{ id:"release",mode:"docker",status:"staging",port:10360,updated_at:"2026-01-01",
      last_verification:{ok:false,checked_at:"2026-01-01",path:"/demo",http:{status:200,latency_ms:15,content_match:false,error:null},
        logs:{issues:["[stderr] UncaughtException"]},browser:{status:"failed",message:"",issues:["资源不可用"],artifacts:["desktop","mobile"]}} }]);
  });
  const user=userEvent.setup();
  render(<Services onDrawer={() => {}} />);
  await user.click(await screen.findByText("查看验收报告"));
  expect(screen.getByText(/HTTP 200.+内容不匹配/)).toBeVisible();
  expect(screen.getByText("[stderr] UncaughtException")).toBeVisible();
  expect(screen.getByText("资源不可用")).toBeVisible();
  expect(screen.getByRole("button",{name:"下载移动端截图"})).toBeVisible();
  await user.click(screen.getByRole("button",{name:"发布上线"}));
  await user.type(screen.getByLabelText("请求路径"),"dashboard");
  await user.type(screen.getByLabelText("响应应包含"),"ready");
  await user.click(screen.getByLabelText("要求桌面及移动浏览器验收"));
  expect(post).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button",{name:"确认发布"}));
  await waitFor(()=>expect(post).toHaveBeenCalledWith({action:"promote",path:"/dashboard",expected_content:"ready",check_browser:true}));
});
