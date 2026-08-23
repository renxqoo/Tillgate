/**
 * 成功信封（v1 encodeResult/encodeGemini 迁移）：inference 交付三态 → HTTP Response。
 *   StreamDelivered（ok+stream）  → SSE 字节流原样直传（§3.6 数据面：不缓冲不改写；
 *                                  codec 端点的线格式转换流由 codec.encodeStream 先行）
 *   ChatDelivered rawBody         → 二进制 200 + 原始 content-type
 *   ChatDelivered body+status     → JSON（codec 端点 200 时先编码回外部线格式）
 *   PassthroughDelivered          → {status, code, message} 原样出站（上游 4xx 透传，
 *                                  ADR-0004——inference 已按线协议翻译）
 * x-request-id 显式带：raw Response 不走 Hono 的 c.header 合并路径，缺它则流式客户端
 * 无法把账单/日志与本响应对齐（非流式 c.json 自动带）。
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ChatDelivered, PassthroughDelivered, StreamDelivered } from '@tokenlens/inference';

export type InferenceDelivered = ChatDelivered | StreamDelivered | PassthroughDelivered;

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
  // nginx 反代默认 proxy_buffering on 会缓冲整条 SSE（首字节到达前攒满缓冲）——显式关闭
  'x-accel-buffering': 'no',
};

export function sseResponse(stream: ReadableStream<Uint8Array>, requestId?: string): Response {
  return new Response(stream, {
    status: 200,
    headers: { ...SSE_HEADERS, ...(requestId != null ? { 'x-request-id': requestId } : {}) },
  });
}

export interface EncodeDeps {
  /** codec 端点出站编码（响应体/流线格式化）；无 codec 端点缺省 */
  encodeResponse?: (body: unknown) => unknown;
  encodeStream?: (stream: ReadableStream<Uint8Array>, model: string) => ReadableStream<Uint8Array>;
  model: string;
  requestId?: string;
}

export async function encodeDelivered(
  json: (body: unknown, status?: ContentfulStatusCode) => Response,
  result: InferenceDelivered,
  deps: EncodeDeps,
): Promise<Response> {
  if ('stream' in result && result.ok && result.status === 200) {
    const body = deps.encodeStream != null ? deps.encodeStream(result.stream, deps.model) : result.stream;
    return sseResponse(body, deps.requestId);
  }
  if ('rawBody' in result && result.rawBody instanceof Uint8Array) {
    return new Response(result.rawBody, {
      status: 200,
      headers: {
        'content-type': result.rawContentType ?? 'application/octet-stream',
        ...(deps.requestId != null ? { 'x-request-id': deps.requestId } : {}),
      },
    });
  }
  if ('passthrough' in result && result.passthrough) {
    // ADR-0004：上游 4xx 原码 + 已翻译/脱敏的消息出站；code 走信封 message 位（线协议已由 inference 保持）
    return json({ error: { code: result.code, message: result.message ?? result.code } }, result.status as ContentfulStatusCode);
  }
  if ('body' in result) {
    if (deps.encodeResponse != null && result.status === 200) {
      return json(deps.encodeResponse(result.body) as Record<string, unknown>);
    }
    return json(result.body, result.status as ContentfulStatusCode);
  }
  return json({ error: { code: 'gateway.invalid_body', message: 'unrecognized delivery shape' } }, 500);
}
