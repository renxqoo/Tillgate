import { ADMIN_API_BASE_URL, getCookieHeader } from "@ai-gateway/api-client";

/**
 * 凭证截图代理：浏览器同源请求（3002）→ 服务端带管理员会话转发到 admin-api（8790）。
 * admin-api 的凭证端点受鉴权保护；<img> 无法直接带 cookie 跨源访问，故在此代理。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await ctx.params;
  const cookie = await getCookieHeader();
  const res = await fetch(`${ADMIN_API_BASE_URL}/api/admin/vouchers/${encodeURIComponent(key)}`, {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  });
  if (!res.ok) return new Response("not found", { status: res.status });
  const data = await res.arrayBuffer();
  return new Response(data, {
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}
