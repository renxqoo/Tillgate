import { ADMIN_API_BASE_URL, getAdminSessionToken } from "@ai-gateway/api-client";

/**
 * 凭证截图代理：浏览器同源请求（3002）→ 服务端带 Bearer 会话转发到 admin-api。
 * 凭证端点受鉴权保护；<img> 无法带凭证跨源访问，故在此代理。
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ key: string }> },
): Promise<Response> {
  const { key } = await ctx.params;
  const token = await getAdminSessionToken();
  const res = await fetch(`${ADMIN_API_BASE_URL}/v1/vouchers/${encodeURIComponent(key)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    cache: "no-store",
  });
  if (!res.ok) return new Response("not found", { status: res.status });
  const data = await res.arrayBuffer();
  return new Response(data, {
    headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" },
  });
}
