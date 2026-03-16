const STATIC_PAGE_MAP: Record<string, string> = {
  "/login": "/function/pages/login.html",
  "/chat": "/function/pages/chat.html",
  "/imagine": "/function/pages/imagine.html",
  "/video": "/function/pages/video.html",
  "/voice": "/function/pages/voice.html",
  "/admin/login": "/admin/pages/login.html",
  "/admin/pages/datacenter": "/admin/pages/datacenter.html",
  "/admin/token": "/admin/pages/token.html",
  "/admin/config": "/admin/pages/config.html",
  "/admin/cache": "/admin/pages/cache.html",
};

export function getStaticPagePath(pathname: string): string | null {
  return STATIC_PAGE_MAP[pathname] ?? null;
}

export function getFaviconAssetPath(): string {
  return "/common/img/favicon/favicon.ico";
}
