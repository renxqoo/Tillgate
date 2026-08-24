import { NextResponse, type NextRequest } from 'next/server';

import { SESSION_COOKIE } from '@tillgate/api-client/next';

/**
 * 未登录访问受保护页 → 跳登录页并携带 next 回跳地址（Next 16 proxy 约定——
 * middleware 文件约定已废弃）。requireMe()（layout 内）仍做权威校验；
 * 这里只做「有无会话 Cookie」的快速门卫 + 回跳透传。
 */
export default function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const hasSession = req.cookies.has(SESSION_COOKIE);
  if (!hasSession) {
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*'],
};
