import type { FastifyInstance } from "fastify";
import { searchQuerySchema } from "@codexdeck/shared";
import type { ServerContext } from "../app.js";
import { createRequireAdmin } from "../auth.js";
import { GlobalSearch } from "../db/global-search.js";

export function registerSearchRoute(app: FastifyInstance, ctx: ServerContext) {
  const index = new GlobalSearch(ctx.native,ctx.masker);
  let timer: NodeJS.Timeout;
  function next(delay: number) {
    timer = setTimeout(() => {
      let busy = false;
      try { busy = index.drain() === 24; }
      catch { app.log.error("Search indexing failed. Pending records will be retried."); }
      next(busy ? 0 : 500);
    },delay);
    timer.unref();
  }
  next(0);
  app.addHook("onClose",async () => { clearTimeout(timer); index.close(); });
  app.get("/api/search",{preHandler:createRequireAdmin(ctx)},async (request,reply) => {
    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({error:"Invalid search query."});
    const query = parsed.data;
    index.drain(8);
    return reply.header("Cache-Control","private, no-store").send(index.search(query));
  });
}
