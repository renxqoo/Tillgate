/**
 * 流式上游派发（单次尝试体，从 create-ai.chatStream 拆出——withRetry 的回调）：
 * fetch → 4xx 读体映射 → 原生流归一 → peekFirstChunk（空流/首帧错误识别）。
 * 流式不用 totalMs（流可持续很久，由 heartbeat/inactivity 管理）；connectMs 保证连接。
 * 流式重试仅限首字节前（peek 在 withRetry 内部）；流开始后失败发错误帧不重试。
 */
import type { CircuitBreaker } from '../breaker/breaker';
import type { DeadCredentialTracker } from '../dead-credential/tracker';
import type { ProtocolAdapter, UpstreamRequestPlan } from '../adapters/protocol-adapter';
import { classifyTransportError } from '../errors/classify';
import {
  abortedError,
  emptyError,
  invalidResponseError,
  serverDrainingError,
} from '../errors/internal';
import { asServerDrainAbort } from '../errors/server-drain';
import { firstChunkStreamError, peekFirstChunk, PeekTimeoutError } from '../internal/stream';
import { tryParseJson } from '../internal/util';
import { BodyTooLargeError, fetchUpstream, readBody } from '../transport/http-client';
import type { AiConfig } from '../config';
import type { AiEvent } from '../events';
import type { ChannelDesc, RequestCtx, UpstreamError } from '../types';
import { isUpstreamError } from './context';

/** 单次尝试结果：首帧已验证的透传流 */
export type StreamAttemptResult =
  | { ok: true; value: ReadableStream<Uint8Array> }
  | { ok: false; error: UpstreamError; empty?: boolean };

export interface StreamAttemptDeps {
  channel: ChannelDesc;
  ctx: RequestCtx;
  url: string;
  plan: UpstreamRequestPlan;
  finalBody: unknown;
  adapter: ProtocolAdapter;
  breaker: CircuitBreaker;
  credential: DeadCredentialTracker;
  cfg: AiConfig;
  log: { info: (msg: string, ...args: unknown[]) => void };
  emit: (e: AiEvent) => void;
  key: string;
}

export function createStreamAttempt(deps: StreamAttemptDeps) {
  const { channel, ctx, url, plan, finalBody, adapter, breaker, credential, cfg, log, emit, key } =
    deps;
  const { requestId } = ctx;
  const fail = async (
    error: UpstreamError,
    empty?: boolean,
  ): Promise<{ ok: false; error: UpstreamError; empty?: boolean }> => {
    await breaker.recordFailure({ circuitTrip: error.circuitTrip });
    if (error.deadCredential) await credential.recordFailure({ deadCredential: true });
    return { ok: false, error, empty };
  };
  return async (attempt: number, signal: AbortSignal): Promise<StreamAttemptResult> => {
    log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
    emit({ type: 'attempt_start', requestId, channelKey: key, attempt, atMs: Date.now() });
    try {
      const serializedBody = JSON.stringify(finalBody);
      const signedHeaders = adapter.signRequest
        ? {
            ...plan.headers,
            ...(await adapter.signRequest({
              url: new URL(url),
              body: serializedBody,
              apiKey: channel.apiKey,
              amzDate: new Date(),
            })),
          }
        : plan.headers;
      const res = await fetchUpstream(
        url,
        {
          method: 'POST',
          headers: signedHeaders,
          body: serializedBody,
        },
        {
          connectMs: cfg.timeout.connectMs,
          signal,
          allowLocal: cfg.allowLocalUrl,
          allowedHosts: cfg.allowedHosts,
        },
      );
      if (res.status >= 400) {
        const raw = await readBody(res, { signal });
        return fail(adapter.mapError(res.status, tryParseJson(raw) ?? raw));
      }
      if (!res.body) return fail(invalidResponseError());
      // D3：空流检测（tee 分流，不破坏流式）
      // 原生线格式先归一为规范形 SSE（peek/首帧错误识别/scanner 全部只面对规范形）
      const upstreamBody = adapter.translateUpstreamStream
        ? adapter.translateUpstreamStream(res.body, ctx.model)
        : res.body;
      // tee 分流不引入缓冲：bodyLimit 与 requestLog 的 clone 均为流式消费
      const peeked = await peekFirstChunk(upstreamBody, {
        signal,
        timeoutMs: cfg.stream.firstByteTimeoutMs,
      });
      if (peeked.done) return fail(emptyError(), true);
      // #6643 同类（流式面）：200 + 首帧即错误（限流/配额错误放在流体内）。
      // 首字节尚未发给客户端——在 peek 处识别即可安全进入 withRetry（同渠道
      // 退避重试），耗尽后 failEarly 发 failed 终态事件 → 网关换渠道。
      const firstFrameError = firstChunkStreamError(peeked.first!);
      if (firstFrameError) {
        // 放弃 rest（tee branchB = 完整上游 body）必须 cancel，否则连接泄漏
        void peeked.rest?.cancel().catch(() => {});
        return fail(firstFrameError);
      }
      return { ok: true, value: peeked.rest! };
    } catch (err) {
      if (asServerDrainAbort(signal.reason)) return fail(serverDrainingError());
      if (signal.aborted) return fail(abortedError());
      if (err instanceof BodyTooLargeError) return fail(invalidResponseError());
      if (err instanceof PeekTimeoutError) return fail(classifyTransportError('timeout'));
      if (isUpstreamError(err)) return fail(err);
      return fail(classifyTransportError('network'));
    }
  };
}
