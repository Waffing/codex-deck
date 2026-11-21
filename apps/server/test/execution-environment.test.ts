import Database from "better-sqlite3";
import {expect,it,vi} from "vitest";
import {resolveExecutor,savedExecutorImage,saveExecutorImage} from "../src/codex/execution-environment.js";

const base={linux:true,nonRoot:true,native:false,inContainer:true};
const digest="sha256:"+"a".repeat(64);
const mounts=[{Type:"bind",Destination:"/workspaces",Source:"/srv/projects"}];
it("resolves the running control image by digest and checks its executor label",async()=>{
  const cli=vi.fn(async(_file:string,args:string[])=>{
    if(args[0]==="inspect")return digest+" "+JSON.stringify(mounts);
    if(args[1]==="ls")return "";
    if(args[0]==="run"){
      expect(args).toEqual(expect.arrayContaining(["--read-only","--cap-drop","ALL","--network","none","--entrypoint","node",digest]));
      expect(args.at(-1)).toContain('execFileSync("codex"');
      expect(args.at(-1)).toContain('execFileSync("git"');
      expect(args.at(-1)).toContain("runner-entry.js");
      return "";
    }
    expect(args.at(-1)).toBe(digest);
    return digest+" 1";
  });
  await expect(resolveExecutor(base,cli)).resolves.toEqual({strategy:"docker",id:digest,image:digest,mounts});
});

it("uses a configured image ahead of auto discovery and rejects an incompatible override",async()=>{
  const cli=vi.fn(async(_file:string,args:string[])=>{
    if(args[0]==="inspect")return digest+" []";
    expect(args.at(-1)).toBe("registry.example/deck:stable");
    return digest+" none";
  });
  await expect(resolveExecutor({...base,configured:"registry.example/deck:stable"},cli)).rejects.toThrow("指定的执行镜像不可用");
});

it("native mode needs no Docker and an unavailable container proxy falls back only after a real namespace probe",async()=>{
  const cli=vi.fn(async(file:string,args:string[])=>{
    if(file==="docker")throw new Error("no proxy");
    expect(file).toBe("/usr/bin/bwrap");
    expect(args).toContain("--unshare-all");
    expect(args).not.toContain("--share-net");
    return "";
  });
  expect((await resolveExecutor({...base,inContainer:false,native:true,configured:"irrelevant"},cli)).strategy).toBe("native");
  expect(cli.mock.calls.some(([file])=>file==="docker")).toBe(false);
  expect((await resolveExecutor(base,cli)).strategy).toBe("container_sandbox");
  await expect(resolveExecutor(base,async()=>{throw new Error("denied");})).rejects.toThrow("执行器未就绪");
});

it("runs the native capability check via the service-specific namespace launcher",async()=>{
  vi.stubEnv("CODEXDECK_BWRAP_PATH","/opt/deck/bin/bwrap");
  try {
    const cli=vi.fn(async(file:string,args:string[])=>{
      expect(file).toBe("/opt/deck/bin/bwrap");
      expect(args).toContain("--unshare-all");
      expect(args.at(-1)).toContain("tracking-entry.js");
      expect(args.at(-1)).toContain('execFileSync("codex"');
      return "";
    });
    expect((await resolveExecutor({...base,inContainer:false,native:true},cli)).strategy).toBe("native");
    expect(cli).toHaveBeenCalledOnce();
  } finally {vi.unstubAllEnvs();}
});

it("stores the administrator override in SQLite and permits returning to discovery",()=>{
  const db=new Database(":memory:");
  try {
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)");
    saveExecutorImage(db,"registry.example/deck:test");
    expect(savedExecutorImage(db)).toBe("registry.example/deck:test");
    expect(()=>saveExecutorImage(db,"--privileged")).toThrow();
    saveExecutorImage(db,"");
    expect(savedExecutorImage(db)).toBe("");
  } finally {db.close();}
});
