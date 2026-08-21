import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@ai-gateway/api-client";

/**
 * 未登录访问受保护页 → 跳登录页并携带 next 回跳地址。
 * requireMe()（layout 内）仍做权威校验；这里只做「有无会话 Cookie」的快速门卫 + 回跳透传。
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
