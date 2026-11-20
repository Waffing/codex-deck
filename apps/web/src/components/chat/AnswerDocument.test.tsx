import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { ThreadEvent } from "@codexdeck/shared";
import { AnswerDocument } from "./AnswerDocument";
import { collectTurns, type TaskHistory } from "./Timeline";

afterEach(cleanup);
it("renders GFM and colours prose without rewriting fenced source or fetching remote images", async () => {
  const code = Array.from({length:22}, (_,i)=>`const line${i} = "failed in 20ms";`).join("\n");
  const markdown = `**结论**：已通过，耗时 20ms。警告见 \`src/a.ts\`。\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![remote](https://example.invalid/a.png)\n<script>alert(1)</script>\n\n\`\`\`js\n${code}\n\`\`\``;
  const {container}=render(<AnswerDocument source={markdown} turnId="t" complete onError={()=>{}}/>);
  expect(container.querySelector("strong")).toHaveTextContent("结论");
  expect(container.querySelector(".md-metric")).toHaveTextContent("20ms");
  expect(container.querySelector(".md-danger")).toHaveTextContent("警告");
  expect(screen.getByRole("table")).toBeInTheDocument();
  expect(container.querySelectorAll("img,script,pre .md-danger")).toHaveLength(0);
  expect(container.querySelector("pre code")?.textContent?.trimEnd()).toBe(code);
  const unfold=screen.getByRole("button",{name:"展开全部 22 行"});
  await userEvent.click(unfold);
  expect(unfold).toHaveAttribute("aria-expanded","true");
});
it("keeps the complete answer when WS contains only the tail and merges duplicate history events", () => {
  const text="# 原始正文\n"+"完整内容。".repeat(2500);
  const base={task_id:"task",thread_id:"thread",created_at:"2026-01-01"};
  const frames:ThreadEvent[]=[
    {...base,seq_id:1,type:"answer_delta",payload:{id:"a",text:"开头"}},
    {...base,seq_id:2,type:"answer_delta",payload:{id:"a",text:"结尾"}},
  ];
  const task:TaskHistory={id:"task",status:"completed",updated_at:"2026-01-02",created_at:"2026-01-01",events:frames,answer_markdown:text,prompt:"检查",summary:"摘要",checkpoint_ref:null};
  const [done]=collectTurns({tasks:[task],artifacts:[]},[frames[1]]);
  expect(done.answer).toBe(text);
  const [active]=collectTurns({tasks:[{...task,status:"running",answer_markdown:undefined}],artifacts:[]},[frames[1]]);
  expect(active.answer).toBe("开头结尾");
});
