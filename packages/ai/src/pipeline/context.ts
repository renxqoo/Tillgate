/**
 * 机制链共享小件：渠道维 key / 调用前置校验 / 错误判别 / 事件分发 /
 * fire-and-forget / 重试参数装配（从 create-ai 拆出的无状态纯件）。
 */
import type { CircuitBreaker } from '../breaker/breaker';
import type { DeadCredentialTracker } from '../dead-credential/tracker';
import { invalidConfigError } from '../errors/internal';
import type { RetryOptions } from '../retry/with-retry';
import type { AiConfig } from '../config';
import type { AiEvent } from '../events';
import type { ChannelDesc, RequestCtx, UpstreamError } from '../types';

const noop = (): void => {};

/** 渠道维 key（熔断/死凭据计数维度）：protocol://host */
export function channelKey(channel: ChannelDesc): string {
  try {
    return `${channel.protocol}://${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.protocol}://unknown`;
  }
}

/**
 * 配置校验（fail fast）：apiKey/baseUrl/protocol/model/requestId 必需且非空。
 * 空值返回 invalidConfigError（不发垃圾请求——空 key 会拼出无效 Authorization，错误信息不清晰）。
 */
export function assertChannelAndCtx(channel: ChannelDesc, ctx: RequestCtx): UpstreamError | null {
  if (!channel.apiKey) return invalidConfigError('channel.apiKey 为空');
  if (!channel.baseUrl) return invalidConfigError('channel.baseUrl 为空');
  if (!channel.protocol) return invalidConfigError('channel.protocol 为空');
  if (!ctx.model) return invalidConfigError('ctx.model 为空（真实模型名缺失）');
  if (!ctx.requestId) return invalidConfigError('ctx.requestId 为空（幂等键缺失）');
  return null;
}

/** probe 只校验 channel（无 ctx） */
export function assertChannel(channel: ChannelDesc): UpstreamError | null {
  if (!channel.apiKey) return invalidConfigError('channel.apiKey 为空');
  if (!channel.baseUrl) return invalidConfigError('channel.baseUrl 为空');
  if (!channel.protocol) return invalidConfigError('channel.protocol 为空');
  return null;
}

export function isUpstreamError(e: unknown): e is UpstreamError {
  return (
    e instanceof Error &&
    typeof (e as UpstreamError).code === 'string' &&
    typeof (e as UpstreamError).retryable === 'boolean'
  );
}

export function emitTo(listeners: Array<(e: AiEvent) => void>, e: AiEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* 观察者异常不破坏管道 */
    }
  }
}

/**
 * Best-effort fire-and-forget：执行熔断/死凭据的状态写入但不阻塞数据流，
 * 且吞掉存储错误（Redis 宕机/抖动时绝不能产生 unhandledRejection 崩进程）。
 *
 * 熔断是「尽力而为的保护机制」（见 breaker.ts 注释），其状态写入失败只意味着
 * 本实例的计数/状态可能暂时不准，不应影响正在成功的请求，更不应让 gateway 进程
 * 因 `void rejectedPromise` 触发 Node 默认的 throw-on-unhandledRejection 而崩溃。
 *
 * gateway 注入的 Redis 业务连接配了 enableOfflineQueue:false —— 宕机时命令立即 reject，
 * 若这里用裸 `void breaker.recordSuccess()`，reject 被 `void` 丢弃且无 .catch()，
 * 会冒泡成 unhandledRejection 杀掉整个 gateway 进程（含所有在途 SSE 长连接）。
 */
export function fireAndForget(p: Promise<unknown>): void {
  p.catch(noop);
}

/** ctx（调用方 per-request 覆盖）→ withRetry 参数（cfg 补默认） */
export function retryOptionsOf(cfg: AiConfig, ctx: RequestCtx): RetryOptions {
  return {
    maxAttempts: ctx.maxRetries ?? cfg.retry.maxAttempts,
    baseDelayMs: cfg.retry.baseDelayMs,
    maxDelayMs: cfg.retry.maxDelayMs,
    jitterRatio: cfg.retry.jitterRatio,
    deadlineMs: ctx.deadlineMs ?? cfg.retry.deadlineMs,
    emptyCompletionRetries: cfg.retry.emptyCompletionRetries,
    signal: ctx.signal,
  };
}

/** 准入判定的空壳类型标注（admission 结果只看布尔，不引入新形状） */
export type AdmissionGuard = CircuitBreaker | DeadCredentialTracker;
