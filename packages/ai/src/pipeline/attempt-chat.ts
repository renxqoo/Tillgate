/**
 * chat 非流式单次尝试执行体（withRetry 的 fn，从 create-ai 拆出——动词一文件）。
 * 只做一次上游 POST 的完整机制：签名 → 传输 → 错误映射 → 响应体/usage 提取。
 * 重试编排（withRetry）仍在 create-ai；换渠道候选循环是 inference 的职责（§3.6）。
 */
import type { ChannelDesc, UpstreamError, Usage } from '../types';
import type { AiDefaults, AiDeps } from '../config';
import type { ProtocolAdapter } from '../adapters/protocol-adapter';
import type { AiEvent } from '../events';
import { UpstreamError as UE } from '../errors/kinds';
import { fetchUpstream, readBody, readRawBody } from '../transport/http-client';
import { tryParseJson, withRawBody } from '../internal/json';
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

export type ChatAttemptValue = {
  usage?: Usage;
  body?: unknown;
  rawBody?: Uint8Array;
  rawContentType?: string;
};

export async function chatAttempt(
  env: ChatAttemptEnv,
  attempt: number,
  signal: AbortSignal,
): Promise<
  { ok: true; value: ChatAttemptValue } | { ok: false; error: UpstreamError; empty?: boolean }
> {
  const { adapter, channel, url, headers, finalBody, ctx, cfg, guard, log, key, emit } = env;
  log.info(`[ai] ${ctx.requestId} attempt ${attempt} (${key})`);
  emit({
    type: 'attempt_start',
    requestId: ctx.requestId,
    channelKey: key,
    attempt,
    atMs: Date.now(),
  });
  const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.totalMs)]);
  let outHeaders = headers;
  // B-F2 修复：签名钩子此前仅在 finalBody 已是 string 时触发——JSON 对象体
  // （一切常规路径）永不签名，vertex/bedrock 等签名协议静默裸奔。
  // 先序列化再签（SigV4 需要 payload hash，必须用最终字节串）。
  const bodyStr =
    finalBody instanceof FormData
      ? undefined
      : typeof finalBody === 'string'
        ? finalBody
        : JSON.stringify(finalBody);
  try {
    if (adapter.signRequest && bodyStr !== undefined) {
      const signed = await adapter.signRequest({
        url: new URL(url),
        body: bodyStr,
        apiKey: channel.apiKey,
        at: new Date(),
      });
      outHeaders = { ...headers, ...signed };
    }
    // B-F1 配套：FormData 不带 content-type——multipart boundary 由 fetch 按表单
    // 边界生成；强设 application/json 会把 multipart 体误标成 JSON（解析侧全毁）
    const requestHeaders: Record<string, string> =
      finalBody instanceof FormData
        ? Object.fromEntries(
            Object.entries(outHeaders).filter(([k]) => k.toLowerCase() !== 'content-type'),
          )
        : { 'content-type': 'application/json', ...outHeaders };
    const res = await fetchUpstream(
      url,
      {
        method: 'POST',
        headers: requestHeaders,
        // bodyStr undefined 仅当 finalBody 是 FormData（上方的 instanceof 判定）
        body: bodyStr !== undefined ? bodyStr : (finalBody as FormData),
      },
      { connectMs: cfg.timeout.connectMs, signal: totalSignal, guard },
    );
    if (!res.ok) {
      const raw = await readBody(res, { signal: totalSignal });
      // rawBody 保真(§3.6 例外 3 细节层):出站 message 脱敏,原文随错误携带供日志/审计
      return {
        ok: false as const,
        error: withRawBody(
          adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers)),
          raw,
        ),
      };
    }
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const raw = await readBody(res, { signal: totalSignal });
      const body = tryParseJson(raw);
      if (body === null) return { ok: false as const, error: new UE({ kind: 'invalid_response' }) };
      if (adapter.translateResponseBody) {
        const translated = adapter.translateResponseBody(body);
        return {
          ok: true as const,
          value: {
            usage: adapter.extractUsage(translated) ?? adapter.extractUsage(body) ?? undefined,
            body: translated,
          },
        };
      }
      return {
        ok: true as const,
        value: { usage: adapter.extractUsage(body) ?? undefined, body },
      };
    }
    const rawBody = await readRawBody(res, { signal: totalSignal });
    return { ok: true as const, value: { rawBody, rawContentType: ct } };
  } catch (err) {
    if (err instanceof UE) return { ok: false as const, error: err };
    return {
      ok: false as const,
      error:
        err instanceof Error && err.message === 'aborted'
          ? new UE({ kind: 'canceled' })
          : new UE({ kind: 'network', message: String(err) }),
    };
  }
}
