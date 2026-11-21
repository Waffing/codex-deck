import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { workspaceSchema, type Artifact } from "@codexdeck/shared";
import { DrawerContent } from "./DrawerContent";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("keeps a foreign snapshot read-only even when the current workspace has the same path", async () => {
  const workspace = workspaceSchema.parse({id:"selected",name:"当前项目",path:"selected",status:"ready",created_at:"",updated_at:""});
  const artifact: Artifact = {id:"snapshot",workspace_id:"source",thread_id:null,turn_id:null,name:"README.md",path:"README.md",change_type:"added",mime_type:"text/markdown",created_at:""};
  const fetch = vi.fn(async (_url:string) => new Response("# 归档版本"));
  vi.stubGlobal("fetch", fetch);
  const tab = {kind:"file" as const,title:artifact.name,path:artifact.path,artifact};
  const view = render(<DrawerContent workspace={workspace} tab={tab} onOpen={()=>{}}/>);
  expect(await screen.findByRole("heading",{name:"归档版本"})).toBeInTheDocument();
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/artifacts/snapshot/content");
  expect(screen.queryByRole("button",{name:"编辑工作区文件"})).toBeNull();
  view.rerender(<DrawerContent workspace={{...workspace,id:"source"}} tab={tab} onOpen={()=>{}}/>);
  expect(screen.getByRole("button",{name:"编辑工作区文件"})).toBeInTheDocument();
});
