import {defineConfig} from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {fileURLToPath} from "node:url";
const target = "http://127.0.0.1:" + (process.env.CODEXDECK_PORT ?? "3210");
export default defineConfig({
  plugins:[react(),tailwindcss()], resolve:{alias:{"@":fileURLToPath(new URL("./src",import.meta.url))}},
  build:{
    rollupOptions:{output:{manualChunks:{
      "react-runtime":["react","react-dom/client"],
      "markdown":["react-markdown","remark-gfm"],
      "syntax":["rehype-highlight"],
    }}},
  },
  server:{proxy:{"/api":{target},"/ws":{target,ws:true},"/preview":{target,ws:true}}},
  test:{environment:"jsdom",include:["src/**/*.test.{ts,tsx}","tests/**/*.test.{ts,tsx}"],globals:true,setupFiles:["./src/test-setup.ts"]},
});
