import type { MiddlewareHandler } from "hono";
import type { Env } from "./env";
import { dbFirst } from "./db";
import { DEFAULT_CURRENT_CONFIG, getCurrentConfigSection, normalizeApiKeyList } from "./currentConfig";
import { validateApiKey } from "./repo/apiKeys";
import { verifyAdminSession } from "./repo/adminSessions";

export interface ApiAuthInfo {
  key: string | null;
  name: string;
  is_admin: boolean;
}

function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || null;
}

function queryOrBearerToken(c: any): string | null {
  const bearer = bearerToken(c.req.header("Authorization") ?? null);
  if (bearer) return bearer;
  const queryToken = String(c.req.query("function_key") ?? "").trim();
  return queryToken || null;
}

function authError(message: string, code: string): Record<string, unknown> {
  return {
    error: {
      message,
      type: "authentication_error",
      code,
    },
  };
}

async function getAuthConfig(env: Env) {
  try {
    return await getCurrentConfigSection(env, "app");
  } catch (error) {
    console.error("Failed to load app config for auth, falling back to defaults:", error);
    return DEFAULT_CURRENT_CONFIG.app;
  }
}

async function countActiveApiKeys(env: Env): Promise<number> {
  try {
    const row = await dbFirst<{ c: number }>(env.DB, "SELECT COUNT(1) as c FROM api_keys WHERE is_active = 1");
    return row?.c ?? 0;
  } catch (error) {
    console.error("Failed to count active API keys during auth:", error);
    return 0;
  }
}

async function resolveApiAuthInfo(env: Env, token: string): Promise<ApiAuthInfo | null> {
  return resolveApiAuthInfoWithConfig(await getAuthConfig(env), env, token);
}

async function resolveApiAuthInfoWithConfig(
  current: Record<string, unknown>,
  env: Env,
  token: string,
): Promise<ApiAuthInfo | null> {
  const globalKeys = normalizeApiKeyList(current.api_key);
  const adminKey = String(current.app_key ?? "").trim();

  if (adminKey && token === adminKey) {
    return { key: token, name: "Admin Key", is_admin: true };
  }

  if (globalKeys.includes(token)) {
    return { key: token, name: "Default API Key", is_admin: true };
  }

  const keyInfo = await validateApiKey(env.DB, token);
  if (!keyInfo) return null;

  return { key: keyInfo.key, name: keyInfo.name, is_admin: false };
}

export const requireApiAuth: MiddlewareHandler<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }> = async (
  c,
  next,
) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  const current = await getAuthConfig(c.env);
  const globalKeys = normalizeApiKeyList(current.api_key);

  if (!token) {
    if (!globalKeys.length) {
      if ((await countActiveApiKeys(c.env)) === 0) {
        c.set("apiAuth", { key: null, name: "Anonymous", is_admin: false });
        return next();
      }
    }
    return c.json(authError("Missing bearer token", "missing_token"), 401);
  }

  const authInfo = await resolveApiAuthInfoWithConfig(current, c.env, token);
  if (authInfo) {
    c.set("apiAuth", authInfo);
    return next();
  }

  return c.json(authError(`Invalid token, length ${token.length}`, "invalid_token"), 401);
};

export const requireModelAuth: MiddlewareHandler<{ Bindings: Env; Variables: { apiAuth: ApiAuthInfo } }> = async (
  c,
  next,
) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  const current = await getAuthConfig(c.env);

  if (!token) {
    const globalKeys = normalizeApiKeyList(current.api_key);
    if (!globalKeys.length && (await countActiveApiKeys(c.env)) === 0) {
      c.set("apiAuth", { key: null, name: "Anonymous", is_admin: false });
      return next();
    }

    const functionAccess = verifyFunctionAccessWithConfig(current, null);
    if (functionAccess.ok) {
      c.set("apiAuth", { key: null, name: "Function Access", is_admin: false });
      return next();
    }

    return c.json(authError("Missing bearer token", "missing_token"), 401);
  }

  const authInfo = await resolveApiAuthInfoWithConfig(current, c.env, token);
  if (authInfo) {
    c.set("apiAuth", authInfo);
    return next();
  }

  const functionAccess = verifyFunctionAccessWithConfig(current, token);
  if (functionAccess.ok) {
    c.set("apiAuth", { key: null, name: "Function Key", is_admin: false });
    return next();
  }

  return c.json(authError(`Invalid token, length ${token.length}`, "invalid_token"), 401);
};

export const requireAdminAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const token = bearerToken(c.req.header("Authorization") ?? null);
  if (!token) return c.json({ error: "Missing admin credential", code: "MISSING_SESSION" }, 401);

  const current = await getAuthConfig(c.env);
  const adminPassword = String(current.app_key ?? "").trim();
  if (adminPassword && token === adminPassword) {
    return next();
  }

  const ok = await verifyAdminSession(c.env.DB, token);
  if (!ok) return c.json({ error: "Admin session expired", code: "SESSION_EXPIRED" }, 401);
  return next();
};

export async function isAdminAuthorized(env: Env, token: string | null): Promise<boolean> {
  if (!token) return false;
  const current = await getAuthConfig(env);
  const adminPassword = String(current.app_key ?? "").trim();
  if (adminPassword && token === adminPassword) return true;
  return verifyAdminSession(env.DB, token);
}

export async function getInternalMasterToken(env: Env): Promise<string> {
  const current = await getAuthConfig(env);
  const adminPassword = String(current.app_key ?? "").trim();
  if (adminPassword) return adminPassword;
  return normalizeApiKeyList(current.api_key)[0] ?? "";
}

export async function verifyFunctionAccess(
  env: Env,
  token: string | null,
): Promise<{ ok: true } | { ok: false; message: string; code: string }> {
  return verifyFunctionAccessWithConfig(await getAuthConfig(env), token);
}

function verifyFunctionAccessWithConfig(
  current: Record<string, unknown>,
  token: string | null,
): { ok: true } | { ok: false; message: string; code: string } {
  const functionKey = String(current.function_key ?? "").trim();
  const functionEnabled = Boolean(current.function_enabled);
  const adminPassword = String(current.app_key ?? "").trim();

  if (!functionKey) {
    if (functionEnabled) return { ok: true };
    return { ok: false, message: "Function access is disabled", code: "FUNCTION_DISABLED" };
  }

  if (!token) {
    return { ok: false, message: "Missing authentication token", code: "MISSING_FUNCTION_KEY" };
  }

  if (token === functionKey || (adminPassword && token === adminPassword)) {
    return { ok: true };
  }

  return { ok: false, message: "Invalid authentication token", code: "INVALID_FUNCTION_KEY" };
}

export const requireFunctionAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const access = await verifyFunctionAccess(c.env, queryOrBearerToken(c));
  if (!access.ok) {
    return c.json({ error: access.message, code: access.code }, 401);
  }
  return next();
};
