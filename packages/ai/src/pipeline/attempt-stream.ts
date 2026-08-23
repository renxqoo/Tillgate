/**
 * chat 流式单次尝试执行体（withRetry 的 fn，从 create-ai 拆出——动词一文件）。
 * 只做「首字节前」的一次尝试：签名 → 传输 → 首帧探测（空流/流内错误识别）；
 * 重试仅限首字节前，流开始后交给 relay（relay-stream 保证）。
 */
import type { ChannelDesc, UpstreamError } from '../types';
import type { AiDefaults, AiDeps } from '../config';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import type { AiEvent } from '../events';
import { UpstreamError as UE } from '../errors/kinds';
import { canceledError, emptyError } from '../errors/internal';
import { asServerDrainAbort } from '../errors/server-drain';
import { fetchUpstream, readBody, BodyTooLargeError } from '../transport/http-client';
import { tryParseJson, withRawBody } from '../internal/json';
import {
  peekFirstChunk,
  firstChunkStreamError,
  firstChunkErrorBody,
  PeekTimeoutError,
} from '../internal/stream';
import type { CallCtx } from './context';

export interface StreamAttemptEnv {
  adapter: ProtocolAdapter;
  channel: ChannelDesc;
  url: string;
  headers: Record<string, string>;
  /** finalize 后的最终请求体（本路径恒为 JSON 可序列化对象） */
  finalBody: unknown;
  ctx: CallCtx;
  cfg: AiDefaults;
  guard: AiDeps['guardUrl'];
  key: string;
  emit: (e: AiEvent) => void;
}

export async function streamAttempt(
  env: StreamAttemptEnv,
  attempt: number,
  signal: AbortSignal,
): Promise<
  | { ok: true; value: ReadableStream<Uint8Array> }
  | { ok: false; error: UpstreamError; empty?: boolean }
> {
  const { adapter, channel, url, headers, finalBody, ctx, cfg, guard, key, emit } = env;
  emit({
    type: 'attempt_start',
    requestId: ctx.requestId,
    channelKey: key,
    attempt,
    atMs: Date.now(),
  });
  let outHeaders = headers;
  const bodyStr = JSON.stringify(finalBody);
  // B-F2 同修：流式同样过签名钩子（此前整条 chatStream 路径无签名——
  // vertex 流式请求会裸奔 401；签名用最终字节串，与 SigV4 payload hash 语义一致）
  if (adapter.signRequest) {
    const signed = await adapter.signRequest({
      url: new URL(url),
      body: bodyStr,
      apiKey: channel.apiKey,
      at: new Date(),
    });
    outHeaders = { ...headers, ...signed };
  }
  try {
    // v1 语义：流式不用 totalMs（流可持续很久，由 heartbeat/inactivity 管理）；
    // connectMs 只覆盖建连阶段（fetchUpstream 内部定时器），首字节预算由
    // peekFirstChunk 独立判定（timeout 类错误）——不得用 connectMs 包住
    // fetch+peek 全程（否则 firstByteTimeoutMs 永不可达、超时误判 empty）
    const res = await fetchUpstream(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...outHeaders },
        body: bodyStr,
      },
      { connectMs: cfg.timeout.connectMs, signal, guard },
    );
    if (!res.ok) {
      const raw = await readBody(res, { signal });
      // rawBody 保真(§3.6 例外 3 细节层):出站 message 脱敏,原文随错误携带供日志/审计
      return {
        ok: false as const,
        error: withRawBody(
          adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers)),
          raw,
        ),
      };
    }
    if (!res.body)
      return {
        ok: false as const,
        error: new UE({ kind: 'invalid_response', message: 'no body' }),
      };
    const upstream = adapter.translateUpstreamStream
      ? adapter.translateUpstreamStream(res.body, ctx.model)
      : res.body;
    // 首帧探测（peek）：空流/首帧错误在此识别——重试仅限首字节前
    const peek = await peekFirstChunk(upstream, {
      timeoutMs: cfg.stream.firstByteTimeoutMs,
      signal,
    });
    if (peek.done || !peek.rest) return { ok: false as const, error: emptyError(), empty: true };
    const fe = peek.first ? firstChunkStreamError(peek.first) : null;
    if (fe) {
      // 首帧即错误（200 + 流内错误体）：放弃 rest 必须 cancel（tee 分支泄漏）
      void peek.rest.cancel().catch(() => {});
      // B-F3 修复：首帧是 SSE 文本，直接 tryParseJson 恒失败会把 vendorCode
      // 丢成 status 兜底（quota → invalid_request 误分类，重试/熔断判定失真）。
      // 用扫描器剥壳还原错误信封后交厂商错误表。
      return {
        ok: false as const,
        error: adapter.mapError(200, firstChunkErrorBody(peek.first!) ?? peek.first!),
      };
    }
    return { ok: true as const, value: peek.rest };
  } catch (err) {
    // v1 分类序：drain → 取消 → 超限 → 首字节超时 → 传输错误透传 → 网络
    if (asServerDrainAbort(signal.reason))
      return { ok: false as const, error: new UE({ kind: 'server_draining' }) };
    if (signal.aborted) return { ok: false as const, error: canceledError() };
    if (err instanceof BodyTooLargeError)
      return {
        ok: false as const,
        error: new UE({
          kind: 'invalid_response',
          message: 'upstream error body exceeds limit',
        }),
      };
    if (err instanceof PeekTimeoutError)
      return {
        ok: false as const,
        error: new UE({
          kind: 'timeout',
          message: `no first byte from upstream within ${cfg.stream.firstByteTimeoutMs}ms`,
        }),
      };
    if (err instanceof UE) return { ok: false as const, error: err };
    return { ok: false as const, error: new UE({ kind: 'network', message: String(err) }) };
  }
}
