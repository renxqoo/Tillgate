/**
 * 操练场代理（BFF）：浏览器 fetch('/api/playground/chat/completions') → 本路由
 * 取会话 HttpOnly cookie 换 Bearer → client-api /v1/playground/chat/completions
 * → SSE 字节流原样回传（服务端动作不能流式，故走 route handler）。
 */
import { getSessionToken } from '@ai-gateway/api-client/session';

export const dynamic = 'force-dynamic';

const API_BASE = process.env.CLIENT_API_BASE!;

export async function POST(req: Request): Promise<Response> {
  const token = await getSessionToken();
  if (!token) {
    return Response.json({ error: { code: 'unauthorized', message: '请先登录' } }, { status: 401 });
  }
  const upstream = await fetch(`${API_BASE}/v1/playground/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: await req.text(),
    signal: req.signal, // 浏览器停止生成联动取消上游
  }).catch(() => null);
  if (!upstream) {
    return Response.json({ error: { code: 'playground_unavailable', message: '推理服务暂不可用' } }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: { code: 'playground_upstream_error', message: `上游 ${upstream.status}` } };
    }
    return Response.json(json, { status: upstream.status });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
