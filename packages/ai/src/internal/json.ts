/**
 * 机制链共享 JSON 小件（chat/chatStream 尝试执行体共用，从 create-ai 拆出的无状态纯件）。
 */
import { UpstreamError as UE } from '../errors/kinds';

export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** mapError 结果缺 rawBody 时补原文(细节层保真;出站脱敏只动 message) */
export function withRawBody(error: UE, raw: string): UE {
  if (error.rawBody != null) return error;
  return new UE({
    kind: error.kind,
    message: error.message,
    vendorCode: error.vendorCode,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
    suggestion: error.suggestion,
    rawBody: raw,
  });
}
