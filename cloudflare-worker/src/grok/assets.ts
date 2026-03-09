import type { GrokSettings } from "../settings";
import { normalizeCfCookie } from "../settings";
import { getDynamicHeaders } from "./headers";

const LIST_API = "https://grok.com/rest/assets";
const DELETE_API = "https://grok.com/rest/assets-metadata";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface OnlineAccountInfo {
  token: string;
  token_masked: string;
  pool: "ssoBasic" | "ssoSuper";
  status: string;
  last_asset_clear_at: number | null;
}

export interface OnlineAssetDetail {
  token: string;
  token_masked: string;
  count: number;
  status: string;
  last_asset_clear_at: number | null;
}

export interface OnlineAssetClearResult {
  total: number;
  success: number;
  failed: number;
  skipped?: boolean;
}

export function maskAdminToken(token: string): string {
  return token.length > 24 ? `${token.slice(0, 8)}...${token.slice(-16)}` : token;
}

export function toOnlinePool(tokenType: "sso" | "ssoSuper"): "ssoBasic" | "ssoSuper" {
  return tokenType === "ssoSuper" ? "ssoSuper" : "ssoBasic";
}

function buildCookie(token: string, settings: GrokSettings): string {
  const cfCookie = normalizeCfCookie(settings.cf_clearance ?? "");
  return cfCookie ? `sso-rw=${token};sso=${token};${cfCookie}` : `sso-rw=${token};sso=${token}`;
}

function withTimeout(init: RequestInit): RequestInit {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { ...init, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) };
  }
  return init;
}

function buildHeaders(
  settings: GrokSettings,
  pathname: string,
  token: string,
): Record<string, string> {
  const headers = getDynamicHeaders(settings, pathname);
  headers.Cookie = buildCookie(token, settings);
  headers.Referer = "https://grok.com/files";
  return headers;
}

function parseErrorMessage(prefix: string, status: number, detail: string): string {
  const cleaned = detail.trim();
  return cleaned ? `${prefix}: ${status} ${cleaned.slice(0, 200)}` : `${prefix}: ${status}`;
}

export async function listAssets(
  token: string,
  settings: GrokSettings,
): Promise<{ assetIds: string[]; count: number }> {
  const assetIds: string[] = [];
  const seenPageTokens = new Set<string>();
  let pageToken = "";

  while (true) {
    const url = new URL(LIST_API);
    url.searchParams.set("pageSize", String(DEFAULT_PAGE_SIZE));
    url.searchParams.set("orderBy", "ORDER_BY_LAST_USE_TIME");
    url.searchParams.set("source", "SOURCE_ANY");
    url.searchParams.set("isLatest", "true");
    if (pageToken) {
      if (seenPageTokens.has(pageToken)) break;
      seenPageTokens.add(pageToken);
      url.searchParams.set("pageToken", pageToken);
    }

    const response = await fetch(
      url.toString(),
      withTimeout({
        method: "GET",
        headers: buildHeaders(settings, "/rest/assets", token),
      }),
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(parseErrorMessage("Assets list failed", response.status, detail));
    }

    const payload = (await response.json()) as {
      assets?: Array<{ assetId?: string }>;
      nextPageToken?: string | null;
    };
    for (const asset of payload.assets ?? []) {
      const assetId = String(asset?.assetId ?? "").trim();
      if (assetId) assetIds.push(assetId);
    }

    pageToken = String(payload.nextPageToken ?? "").trim();
    if (!pageToken) break;
  }

  return { assetIds, count: assetIds.length };
}

export async function getAssetDetail(
  token: string,
  settings: GrokSettings,
  account: OnlineAccountInfo | null,
): Promise<OnlineAssetDetail> {
  const result = await listAssets(token, settings);
  return {
    token,
    token_masked: account?.token_masked ?? maskAdminToken(token),
    count: result.count,
    status: "ok",
    last_asset_clear_at: account?.last_asset_clear_at ?? null,
  };
}

export async function clearAssetsForToken(
  token: string,
  settings: GrokSettings,
): Promise<OnlineAssetClearResult> {
  const { assetIds } = await listAssets(token, settings);
  if (!assetIds.length) {
    return { total: 0, success: 0, failed: 0, skipped: true };
  }

  let success = 0;
  let failed = 0;
  for (const assetId of assetIds) {
    const response = await fetch(
      `${DELETE_API}/${encodeURIComponent(assetId)}`,
      withTimeout({
        method: "DELETE",
        headers: buildHeaders(settings, "/rest/assets-metadata", token),
      }),
    );
    if (response.ok) {
      success += 1;
      continue;
    }
    failed += 1;
  }

  return { total: assetIds.length, success, failed };
}
