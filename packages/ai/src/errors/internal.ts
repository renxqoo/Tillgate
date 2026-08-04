import type { UpstreamError } from '../types.js';
import { createUpstreamError } from './classify.js';

/**
 * 包内策略性错误（非上游响应分类——那是 classify.ts 的职责）：
 * create-ai 编排层产生、可被 gateway 识别的包自身状态错误。
 * 统一 retryable=false / circuitTrip=false：不参与重试（各自有专门机制驱动）、不计熔断。
 */

/** 空完成：HTTP 200 但无内容。重试由 withRetry 的 empty 标志驱动（≤ emptyCompletionRetries），不叠加普通重试 */
export function emptyError(): UpstreamError {
  return createUpstreamError({
    code: 'empty_completion',
    message: 'upstream returned empty completion (HTTP 200, no content)',
    retryable: false,
    circuitTrip: false,
  });
}

/** 响应格式非法：200 但非 JSON，或响应体超限 */
export function invalidResponseError(): UpstreamError {
  return createUpstreamError({
    code: 'invalid_response',
    message: 'upstream returned non-JSON body',
    retryable: false,
    circuitTrip: false,
  });
}

/** 重试总 deadline 到（withRetry 的 AbortSignal 触发） */
export function abortedError(): UpstreamError {
  return createUpstreamError({
    code: 'aborted',
    message: 'retry deadline exceeded',
    retryable: false,
    circuitTrip: false,
  });
}

/** 熔断打开：渠道被拒（gateway 路由层据此跳过该渠道走 fallback） */
export function circuitOpenError(): UpstreamError {
  return createUpstreamError({
    code: 'circuit_open',
    message: 'circuit open, upstream unavailable',
    retryable: false,
    circuitTrip: false,
    suggestion: '渠道熔断中，请稍后重试',
  });
}
