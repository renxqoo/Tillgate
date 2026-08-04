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

/** 死凭据：渠道凭据已失效（连续 401/403 达阈值），停止路由（gateway 跳过该渠道，告警人工换 Key） */
export function deadCredentialError(): UpstreamError {
  return createUpstreamError({
    code: 'dead_credential',
    message: 'channel credential is invalid (consecutive auth failures)',
    retryable: false,
    circuitTrip: false,
    deadCredential: true,
    suggestion: '渠道凭据失效，请联系管理员更换上游 API Key',
  });
}

/** 配置非法：ChannelDesc/RequestCtx 必需字段缺失或为空（调用方 bug，不应发往上游） */
export function invalidConfigError(message: string): UpstreamError {
  return createUpstreamError({
    code: 'invalid_config',
    message,
    retryable: false,
    circuitTrip: false,
    suggestion: '请检查渠道/请求配置（apiKey、baseUrl、model 等必需字段）',
  });
}
