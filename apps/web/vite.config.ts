import {defineConfig} from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {fileURLToPath} from "node:url";
import {staticShellWorker} from "./pwa-build";
const target = "http://127.0.0.1:" + (process.env.CODEXDECK_PORT ?? "3210");
export default defineConfig({
  plugins:[react(),tailwindcss(),staticShellWorker(),{
    name:"codexdeck-share-dev",apply:"serve",configureServer(server){
      server.middlewares.use((req,_res,next)=>{
        if(req.method==="GET" && /^\/s\/[A-Za-z0-9_-]{32}(?:\?|$)/.test(req.url??""))req.url="/share.html";
        next();
      });
    },
  }], resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},
  build:{
    manifest:true,
    rollupOptions:{input:{app:fileURLToPath(new URL("./index.html",import.meta.url)),share:fileURLToPath(new URL("./share.html",import.meta.url))},output:{manualChunks:{
      "react-runtime":["react","react-dom/client"],
      "markdown":["react-markdown","remark-gfm"],
      "syntax":["rehype-highlight"],
    }}},
  },
  server:{proxy:{"/api":{target},"/ws":{target,ws:true},"/preview":{target,ws:true}}},
  test:{environment:"jsdom",include:["src/**/*.test.{ts,tsx}","tests/**/*.test.{ts,tsx}"],globals:true,setupFiles:["./src/test-setup.ts"]},
});
