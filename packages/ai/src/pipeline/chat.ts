/**
 * 非流式上游派发（单次尝试体，从 create-ai.chat 拆出——withRetry 的回调）：
 * fetch → 4xx 读体映射 → 二进制/JSON 分流 → 原生翻译 → 200 包错误分类 → usage。
 * 每次尝试失败即计熔断数（429/4xx/死凭据 circuitTrip=false 自动不计）+ 死凭据计数。
 */
import type { CircuitBreaker } from '../breaker/breaker';
import type { DeadCredentialTracker } from '../dead-credential/tracker';
import type { ProtocolAdapter, UpstreamRequestPlan } from '../adapters/protocol-adapter';
import { classifyBodyOnlyError, classifyTransportError } from '../errors/classify';
import {
  abortedError,
  emptyError,
  invalidResponseError,
  serverDrainingError,
} from '../errors/internal';
import { asServerDrainAbort } from '../errors/server-drain';
import { tryParseJson } from '../internal/util';
import { BodyTooLargeError, fetchUpstream, readBody, readRawBody } from '../transport/http-client';
import { estimateUsage } from '../usage/token-estimate';
import { isUpstreamError } from './context';
import type { AiConfig } from '../config';
import type { AiEvent } from '../events';
import type { ChannelDesc, RequestCtx, UpstreamError, Usage } from '../types';

/** 单次尝试结果（withRetry 回调契约） */
export type ChatAttemptResult =
  | { ok: true; value: { usage?: Usage; body?: unknown; rawBody?: Uint8Array; rawContentType?: string } }
  | { ok: false; error: UpstreamError; empty?: boolean };

export interface ChatAttemptDeps {
  channel: ChannelDesc;
  ctx: RequestCtx;
  /** joinUrl 后的完整上游 URL */
  url: string;
  plan: UpstreamRequestPlan;
  /** finalizeRequestBody 之后的最终请求体 */
  finalBody: unknown;
  adapter: ProtocolAdapter;
  breaker: CircuitBreaker;
  credential: DeadCredentialTracker;
  cfg: AiConfig;
  log: { info: (msg: string, ...args: unknown[]) => void };
  emit: (e: AiEvent) => void;
  key: string;
}

export function createChatAttempt(deps: ChatAttemptDeps) {
  const { channel, ctx, url, plan, finalBody, adapter, breaker, credential, cfg, log, emit, key } = deps;
  const { requestId } = ctx;
  const fail = async (
    error: UpstreamError,
    empty?: boolean,
  ): Promise<{ ok: false; error: UpstreamError; empty?: boolean }> => {
    await breaker.recordFailure({ circuitTrip: error.circuitTrip });
    // 死凭据失败（401/403 + 特征）→ 计数；达阈值后续请求被 credential.canRequest 拒绝
    if (error.deadCredential) await credential.recordFailure({ deadCredential: true });
    return { ok: false, error, empty };
  };
  return async (attempt: number, signal: AbortSignal): Promise<ChatAttemptResult> => {
    log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
    // B4：每次尝试发 attempt_start（gateway 知道第几次尝试、打到哪个渠道）
    emit({ type: 'attempt_start', requestId, channelKey: key, attempt });
    // totalMs = 单次尝试上限；deadlineMs = 全部尝试上限（signal 由 withRetry 管理）
    const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.totalMs)]);
    try {
      // FormData（multipart 模态端点）原样直传——fetch 自动生成 boundary 头，
      // 显式 content-type 会破坏 multipart 边界；签名协议（bedrock）不支持 FormData
      const isFormData = typeof FormData !== 'undefined' && finalBody instanceof FormData;
      const serializedBody = isFormData ? '' : JSON.stringify(finalBody);
      const signedHeaders = adapter.signRequest
        ? { ...plan.headers, ...await adapter.signRequest({ url: new URL(url), body: serializedBody, apiKey: channel.apiKey, amzDate: new Date() }) }
        : { ...plan.headers };
      if (isFormData) delete (signedHeaders as Record<string, string>)['content-type'];
      const res = await fetchUpstream(
        url,
        {
          method: 'POST',
          headers: signedHeaders,
          body: isFormData ? (finalBody as unknown as NonNullable<Parameters<typeof fetchUpstream>[1]>['body']) : serializedBody,
        },
        {
          connectMs: cfg.timeout.connectMs,
          signal: totalSignal,
          allowLocal: cfg.allowLocalUrl,
          allowedHosts: cfg.allowedHosts,
        },
      );
      if (res.status >= 400) {
        const raw = await readBody(res, { signal: totalSignal, maxBytes: 8 * 1024 * 1024 });
        return fail(adapter.mapError(res.status, tryParseJson(raw) ?? raw));
      }
      // 二进制响应（audio_speech 等）：content-type 非 JSON → 原样字节透传
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        const rawBytes = await readRawBody(res, { signal: totalSignal, maxBytes: 32 * 1024 * 1024 });
        if (rawBytes.byteLength === 0) return fail(emptyError(), true);
        return { ok: true, value: { usage: undefined, rawBody: rawBytes, rawContentType: contentType } };
      }
      const raw = await readBody(res, { signal: totalSignal, maxBytes: 8 * 1024 * 1024 });
      if (raw.trim() === '') return fail(emptyError(), true);
      let json = tryParseJson(raw);
      if (json === undefined) return fail(invalidResponseError());
      // 原生线格式（anthropic/gemini/bedrock）→ 规范形：此后分类/计量/响应
      // 全部只面对规范形（管线内部恒为规范形，单一真相）
      if (adapter.translateResponseBody) json = adapter.translateResponseBody(json);
      // #6643 同类（非流式面）：部分供应商把错误对象包在 200 JSON 体里——
      // 必须归类失败（可换渠道），不得按成功 + 估算 usage 计费透传。
      const bodyError = classifyBodyOnlyError(json);
      if (bodyError) return fail(bodyError);
      const usage =
        adapter.extractUsage(json) ??
        estimateUsage(finalBody, json, {
          providerName: ctx.providerName,
          model: ctx.model,
        });
      return { ok: true, value: { usage, body: json } };
    } catch (err) {
      if (asServerDrainAbort(signal.reason)) return fail(serverDrainingError());
      if (signal.aborted) return fail(abortedError());
      if (totalSignal.aborted) return fail(classifyTransportError('timeout'));
      if (err instanceof BodyTooLargeError) {
        return fail(invalidResponseError());
      }
      if (isUpstreamError(err)) return fail(err);
      return fail(classifyTransportError('network'));
    }
  };
}
