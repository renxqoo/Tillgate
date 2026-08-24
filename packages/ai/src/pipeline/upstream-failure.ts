/**
 * 上游非 2xx 的统一失败映射（chat/stream 两个尝试执行体共用，从各自的
 * 内联块收口于此——动词一文件）。rawBody 保真(§3.6 例外 3 细节层)：
 * 出站 message 脱敏，原文随错误携带供日志/审计。
 */
import type { UpstreamError } from '../types';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import { readBody } from '../transport/http-client';
import { tryParseJson, withRawBody } from '../internal/json';

export async function mapUpstreamFailure(
  adapter: ProtocolAdapter,
  res: Response,
  signal: AbortSignal,
): Promise<UpstreamError> {
  const raw = await readBody(res, { signal });
  return withRawBody(
    adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers)),
    raw,
  );
}
