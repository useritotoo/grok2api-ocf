import { Hono } from "hono";
import { requireAdminAuth } from "../auth";
import type { Env } from "../env";

export const adminCompatRoutes = new Hono<{ Bindings: Env }>();

adminCompatRoutes.use("/v1/admin/*", requireAdminAuth);

adminCompatRoutes.get("/v1/admin/verify", (c) => {
  return c.json({ success: true });
});

adminCompatRoutes.all("/v1/admin/*", (c) => {
  const url = new URL(c.req.url);
  const pathname = url.pathname;

  if (pathname.endsWith("/async")) {
    return c.json(
      {
        success: false,
        error: "Async admin jobs are not supported in the Cloudflare Workers build.",
        code: "not_supported",
      },
      501,
    );
  }

  url.pathname = pathname.replace(/^\/v1\/admin\//, "/api/v1/admin/");
  return c.redirect(url.toString(), 307);
});
