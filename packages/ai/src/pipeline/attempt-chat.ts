/**
 * chat 非流式单次尝试执行体（withRetry 的 fn；重试编排在 create-ai）。
 * 只做一次上游 POST 的完整机制：签名 → 传输 → 错误映射 → 响应体/usage 提取。
 * 换渠道候选循环是 inference 的职责。
 */
import type { ChannelDesc, UpstreamError, Usage } from '../types';
import { asRetryDeadlineAbort } from '../errors/retry-deadline.js';
import type { AiDefaults, AiDeps } from '../config';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import type { AiEvent } from '../events';
import { UpstreamError as UE } from '../errors/kinds';
import { fetchUpstream, readBody, readRawBody } from '../transport/http-client';
import { tryParseJson } from '../internal/json';
import { mapUpstreamFailure } from './upstream-failure';
import { emitAttemptStart } from './attempt-start';
import type { CallCtx } from './context';

export interface ChatAttemptEnv {
  adapter: ProtocolAdapter;
  channel: ChannelDesc;
  url: string;
  headers: Record<string, string>;
  /** finalize 后的最终请求体（JSON 可序列化对象或 FormData） */
  finalBody: unknown;
  ctx: CallCtx;
  cfg: AiDefaults;
  guard: AiDeps['guardUrl'];
  log: NonNullable<AiDeps['logger']>;
  key: string;
  emit: (e: AiEvent) => void;
}

export interface ChatAttemptValue {
  usage?: Usage;
  body?: unknown;
  rawBody?: Uint8Array;
  rawContentType?: string;
}

/** 请求体序列化：FormData 原样（不签不序列化）；string 直用；其余 JSON 序列化 */
function serializeBody(finalBody: unknown): string | undefined {
  if (finalBody instanceof FormData) return undefined;
  if (typeof finalBody === 'string') return finalBody;
  return JSON.stringify(finalBody);
}

/**
 * 非流式签名：先序列化再签（SigV4 需要 payload hash，必须用最终字节串）；
 * FormData 体不签。
 */
async function signChatHeaders(input: {
  adapter: ProtocolAdapter;
  channel: ChannelDesc;
  url: string;
  bodyStr: string | undefined;
  headers: Record<string, string>;
}): Promise<Record<string, string>> {
  const { adapter, channel, url, bodyStr, headers } = input;
  if (!adapter.signRequest || bodyStr === undefined) return headers;
  const signed = await adapter.signRequest({
    url: new URL(url),
    body: bodyStr,
    apiKey: channel.apiKey,
    at: new Date(),
  });
  return { ...headers, ...signed };
}

/**
 * FormData 不带 content-type——multipart boundary 由 fetch 按表单
 * 边界生成；强设 application/json 会把 multipart 体误标成 JSON（解析侧全毁）。
 */
function buildRequestHeaders(
  finalBody: unknown,
  outHeaders: Record<string, string>,
): Record<string, string> {
  if (!(finalBody instanceof FormData)) {
    return { 'content-type': 'application/json', ...outHeaders };
  }
  return Object.fromEntries(
    Object.entries(outHeaders).filter(([k]) => k.toLowerCase() !== 'content-type'),
  );
}

/** JSON 响应 → 尝试值：translateResponseBody 优先；usage 提取带原文回退 */
function jsonAttemptValue(adapter: ProtocolAdapter, body: unknown): ChatAttemptValue {
  if (adapter.translateResponseBody) {
    const translated = adapter.translateResponseBody(body);
    return {
      usage: adapter.extractUsage(translated) ?? adapter.extractUsage(body) ?? undefined,
      body: translated,
    };
  }
  return { usage: adapter.extractUsage(body) ?? undefined, body };
}

/** 非流式 catch 分类：预算耗尽 → timeout（可换渠）；客户端 abort → canceled；其余网络 */
function classifyChatFailure(error: unknown, signal: AbortSignal): UpstreamError {
  if (error instanceof UE) return error;
  if (asRetryDeadlineAbort(signal.reason)) {
    return new UE({ kind: 'timeout', message: 'upstream attempt budget exhausted' });
  }
  return error instanceof Error && error.message === 'aborted'
    ? new UE({ kind: 'canceled' })
    : new UE({ kind: 'network', message: String(error) });
}

export async function chatAttempt(
  env: ChatAttemptEnv,
  attempt: number,
  signal: AbortSignal,
): Promise<
  { ok: true; value: ChatAttemptValue } | { ok: false; error: UpstreamError; empty?: boolean }
> {
  const { adapter, channel, url, headers, finalBody, ctx, cfg, guard, log, key, emit } = env;
  log.info(`[ai] ${ctx.requestId} attempt ${attempt} (${key})`);
  emitAttemptStart(emit, { ctx, key, attempt });
  const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.totalMs)]);
  const bodyStr = serializeBody(finalBody);
  try {
    const outHeaders = await signChatHeaders({ adapter, channel, url, bodyStr, headers });
    const res = await fetchUpstream(
      url,
      {
        method: 'POST',
        headers: buildRequestHeaders(finalBody, outHeaders),
        // bodyStr undefined 仅当 finalBody 是 FormData（serializeBody 的 instanceof 判定）
        body: bodyStr !== undefined ? bodyStr : (finalBody as FormData),
      },
      { connectMs: cfg.timeout.connectMs, signal: totalSignal, guard },
    );
    if (!res.ok) {
      return { ok: false as const, error: await mapUpstreamFailure(adapter, res, totalSignal) };
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const raw = await readBody(res, { signal: totalSignal });
      const body = tryParseJson(raw);
      if (body === null) return { ok: false as const, error: new UE({ kind: 'invalid_response' }) };
      return { ok: true as const, value: jsonAttemptValue(adapter, body) };
    }
    const rawBody = await readRawBody(res, { signal: totalSignal });
    return { ok: true as const, value: { rawBody, rawContentType: ct } };
  } catch (error) {
    return { ok: false as const, error: classifyChatFailure(error, signal) };
  }
}
