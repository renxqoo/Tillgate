/**
 * chat 流式单次尝试执行体（withRetry 的 fn；重试编排在 create-ai）。
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
import { fetchUpstream, BodyTooLargeError } from '../transport/http-client';
import {
  peekFirstChunk,
  firstChunkStreamError,
  firstChunkErrorBody,
  PeekTimeoutError,
} from '../internal/stream';
import { mapUpstreamFailure } from './upstream-failure';
import { emitAttemptStart } from './attempt-start';
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

/**
 * 流式请求签名：流式同样过签名钩子；签名用最终字节串，与 SigV4 payload
 * hash 语义一致。无签名钩子的协议原样返回。
 */
async function signStreamHeaders(input: {
  adapter: ProtocolAdapter;
  channel: ChannelDesc;
  url: string;
  bodyStr: string;
  headers: Record<string, string>;
}): Promise<Record<string, string>> {
  const { adapter, channel, url, bodyStr, headers } = input;
  if (!adapter.signRequest) return headers;
  const signed = await adapter.signRequest({
    url: new URL(url),
    body: bodyStr,
    apiKey: channel.apiKey,
    at: new Date(),
  });
  return { ...headers, ...signed };
}

/**
 * 首帧判定：错误帧（200 + 流内错误体）→ 厂商错误表映射；正常首帧 → null。
 * 首帧是 SSE 文本，直接 tryParseJson 恒失败会把 vendorCode 丢成
 * status 兜底（quota → invalid_request 误分类，重试/熔断判定失真）——用扫描器
 * 剥壳还原错误信封后交厂商错误表。放弃 rest 必须 cancel（tee 分支泄漏）。
 */
function firstFrameFailure(
  adapter: ProtocolAdapter,
  first: Uint8Array,
  rest: ReadableStream<Uint8Array>,
): UpstreamError | null {
  const fe = firstChunkStreamError(first);
  if (fe === null) return null;
  void rest.cancel().catch(() => {});
  return adapter.mapError(200, firstChunkErrorBody(first) ?? first);
}

/**
 * 流式尝试的 catch 分类序：
 * drain → 取消 → 超限 → 首字节超时 → 传输错误透传 → 网络。
 */
function classifyStreamAttemptFailure(
  error: unknown,
  signal: AbortSignal,
  firstByteTimeoutMs: number,
): UpstreamError {
  if (asServerDrainAbort(signal.reason)) {
    return new UE({ kind: 'server_draining' });
  }
  if (signal.aborted) {
    return canceledError();
  }
  if (error instanceof BodyTooLargeError) {
    return new UE({ kind: 'invalid_response', message: 'upstream error body exceeds limit' });
  }
  if (error instanceof PeekTimeoutError) {
    return new UE({
      kind: 'timeout',
      message: `no first byte from upstream within ${firstByteTimeoutMs}ms`,
    });
  }
  if (error instanceof UE) {
    return error;
  }
  return new UE({ kind: 'network', message: String(error) });
}

// eslint-disable-next-line max-lines-per-function -- 流式尝试管线:四阶段重构后位于边界,oxfmt 换行推超 1 行
export async function streamAttempt(
  env: StreamAttemptEnv,
  attempt: number,
  signal: AbortSignal,
): Promise<
  | { ok: true; value: ReadableStream<Uint8Array> }
  | { ok: false; error: UpstreamError; empty?: boolean }
> {
  const { adapter, channel, url, headers, finalBody, ctx, cfg, guard, key, emit } = env;
  emitAttemptStart(emit, { ctx, key, attempt });
  const bodyStr = JSON.stringify(finalBody);
  const outHeaders = await signStreamHeaders({ adapter, channel, url, bodyStr, headers });
  try {
    // 流式不用 totalMs（流可持续很久，由 heartbeat/inactivity 管理）；
    // connectMs 只覆盖建连，首字节预算由 peekFirstChunk 独立判定——不得用 connectMs
    // 包住 fetch+peek 全程（否则 firstByteTimeoutMs 永不可达、超时误判 empty）
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
      return { ok: false as const, error: await mapUpstreamFailure(adapter, res, signal) };
    }
    if (!res.body) {
      return {
        ok: false as const,
        error: new UE({ kind: 'invalid_response', message: 'no body' }),
      };
    }
    const upstream = adapter.translateUpstreamStream
      ? adapter.translateUpstreamStream(res.body, ctx.model)
      : res.body;
    // 首帧探测（peek）：空流/首帧错误在此识别——重试仅限首字节前
    const peek = await peekFirstChunk(upstream, {
      timeoutMs: cfg.stream.firstByteTimeoutMs,
      signal,
    });
    if (peek.done || !peek.rest) return { ok: false as const, error: emptyError(), empty: true };
    const failure = peek.first ? firstFrameFailure(adapter, peek.first, peek.rest) : null;
    if (failure !== null) return { ok: false as const, error: failure };
    return { ok: true as const, value: peek.rest };
  } catch (error) {
    const err = classifyStreamAttemptFailure(error, signal, cfg.stream.firstByteTimeoutMs);
    return { ok: false as const, error: err };
  }
}
