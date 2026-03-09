import { Hono } from "hono";
import { requireAdminAuth } from "../auth";
import type { Env } from "../env";
import { adminRoutes } from "./admin";

export const adminCompatRoutes = new Hono<{ Bindings: Env }>();

adminCompatRoutes.use("/v1/admin/*", requireAdminAuth);

adminCompatRoutes.get("/v1/admin/verify", (c) => {
  return c.json({ success: true });
});

adminCompatRoutes.all("/v1/admin/*", (c) => {
  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/v1\/admin\//, "/api/v1/admin/");
  const request = new Request(url.toString(), c.req.raw);
  return adminRoutes.fetch(request, c.env, c.executionCtx);
});
