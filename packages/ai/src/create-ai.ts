import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { loadProfile, mergeRules } from './adapters/profiles/index.js';
import type { ProtocolAdapter } from './adapters/protocol-adapter.js';
import { CircuitBreaker } from './breaker/breaker.js';
import { MemoryBreakerStorage } from './breaker/memory-storage.js';
import { classifyTransportError } from './errors/classify.js';
import { abortedError, circuitOpenError, emptyError, invalidResponseError } from './errors/internal.js';
import { fetchUpstream, readBody } from './transport/http-client.js';
import { relayStream } from './transport/relay-stream.js';
import { estimateTokens, normalizeUsage } from './usage/normalize.js';
import { withRetry, type RetryOptions } from './retry/with-retry.js';
import { defaultAiConfig, type AiConfig, type AiDeps, type BreakerStorage } from './config.js';
import type { AiEvent } from './events.js';
import type {
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  ProbeResult,
  RequestCtx,
  UpstreamError,
  Usage,
} from './types.js';

/**
 * create-ai 组装（ai-package.md §5/§6）：适配器注册表 + withRetry + breaker 绑定 + 事件输出
 *   - 单渠道内重试（withRetry）；换渠道/fallback 模型候选循环是 gateway 的职责
 *   - 熔断按 channelKey（protocol://host）维度，计数只收 circuitTrip=true
 *   - 失败路径双向收敛：非流式返回 ChatResult；流式「流开始前失败」→ 返回含错误帧的流 + failed 事件
 *   - 流式重试仅限首字节前；流开始后失败发错误帧，不重试（由 relay-stream 保证）
 */

const noop = (): void => {};

function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

function channelKey(channel: ChannelDesc): string {
  try {
    return `${channel.protocol}://${new URL(channel.baseUrl).host}`;
  } catch {
    return `${channel.protocol}://unknown`;
  }
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function isUpstreamError(e: unknown): e is UpstreamError {
  return (
    e instanceof Error &&
    typeof (e as UpstreamError).code === 'string' &&
    typeof (e as UpstreamError).retryable === 'boolean'
  );
}

/** 请求 messages 文本总长度（usage 缺失时估算输入 tokens） */
function extractRequestChars(body: unknown): number {
  const messages = asArray(asRecord(body)?.messages);
  if (!messages) return 0;
  let n = 0;
  for (const m of messages) {
    const content = asRecord(m)?.content;
    if (typeof content === 'string') {
      n += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const p = asRecord(part);
        if (p && typeof p.text === 'string') n += p.text.length;
      }
    }
  }
  return n;
}

/** 响应 choices 文本总长度（usage 缺失时估算输出 tokens） */
function extractResponseChars(json: unknown): number {
  const first = asRecord(asArray(asRecord(json)?.choices)?.[0]);
  if (!first) return 0;
  const message = asRecord(first.message);
  if (message && typeof message.content === 'string') return message.content.length;
  if (typeof first.text === 'string') return first.text.length; // 补全类响应
  return 0;
}

/** usage 缺失兜底：请求/响应按字符估算，全部按未缓存计 */
function estimateUsage(reqBody: unknown, resJson: unknown, charPerToken: number): Usage {
  return {
    inputTokens: estimateTokens(extractRequestChars(reqBody), charPerToken),
    cachedInputTokens: 0,
    outputTokens: estimateTokens(extractResponseChars(resJson), charPerToken),
    estimated: true,
    raw: null,
  };
}

export interface Ai {
  /** 非流式（自动 withRetry：可重试错误 + 空完成重试） */
  chat(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): Promise<ChatResult>;
  /** 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试） */
  chatStream(input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: RequestCtx;
  }): Promise<ChatStreamResult>;
  /** 连通性探测（admin-api 渠道测试用） */
  probe(channel: ChannelDesc): Promise<ProbeResult>;
}

function emitTo(listeners: Array<(e: AiEvent) => void>, e: AiEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* 观察者异常不破坏管道 */
    }
  }
}

function authHeaders(channel: ChannelDesc): Record<string, string> {
  return {
    authorization: `Bearer ${channel.apiKey}`,
    'content-type': 'application/json',
  };
}

export function createAi(config?: AiConfig, deps?: AiDeps): Ai {
  const cfg = config ?? defaultAiConfig();
  const breakerStorage: BreakerStorage = deps?.breakerStorage ?? new MemoryBreakerStorage();
  const log = deps?.logger ?? { info: noop, warn: noop, error: noop };

  const adapters = new Map<string, ProtocolAdapter>([
    ['openai-compatible', new OpenAICompatibleAdapter()],
  ]);
  const adapterFor = (channel: ChannelDesc): ProtocolAdapter =>
    adapters.get(channel.protocol) ?? adapters.get('openai-compatible')!;

  const breakerFor = (channel: ChannelDesc): CircuitBreaker =>
    new CircuitBreaker(channelKey(channel), cfg.breaker, breakerStorage, Date.now);

  /** 组装 per-request 上下文：参数抹平 + 熔断准入，返回失败则返回 ChatResult 错误分支 */
  function prepare(input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: RequestCtx;
  }): { ok: true; body: unknown; breaker: CircuitBreaker; adapter: ProtocolAdapter; key: string } | { ok: false; error: UpstreamError } {
    const adapter = adapterFor(input.channel);
    const rules = mergeRules(loadProfile(input.ctx.providerName), input.ctx.paramRules);
    const { body, adjustments } = adapter.normalizeRequest(input.request, rules);
    for (const a of adjustments) {
      log.info(`[ai] ${input.ctx.requestId} param_adjustment ${a.action} ${a.param}`, {
        from: a.from,
        to: a.to,
      });
    }
    return { ok: true, body, breaker: breakerFor(input.channel), adapter, key: channelKey(input.channel) };
  }

  function retryOptions(ctx: RequestCtx): RetryOptions {
    return {
      maxAttempts: ctx.maxRetries ?? cfg.retry.maxAttempts,
      baseDelayMs: cfg.retry.baseDelayMs,
      maxDelayMs: cfg.retry.maxDelayMs,
      jitterRatio: cfg.retry.jitterRatio,
      deadlineMs: ctx.deadlineMs ?? cfg.retry.deadlineMs,
      emptyCompletionRetries: cfg.retry.emptyCompletionRetries,
    };
  }

  return {
    async chat(input) {
      const start = Date.now();
      const prepared = prepare(input);
      if (!prepared.ok) {
        // prepare 目前恒 ok（normalizeRequest 不抛），保留分支防御
        return { status: 'error', error: prepared.error, durationMs: Date.now() - start };
      }
      const { body, breaker, adapter, key } = prepared;
      const { requestId } = input.ctx;

      if (!(await breaker.canRequest())) {
        const err = circuitOpenError();
        log.error(`[ai] ${requestId} circuit open, rejected (${key})`);
        return { status: 'error', error: err, durationMs: Date.now() - start };
      }

      const url = joinUrl(input.channel.baseUrl, '/v1/chat/completions');
      // 每次尝试失败即计熔断数（429/4xx/死凭据 circuitTrip=false 自动不计）
      const fail = async (
        error: UpstreamError,
        empty?: boolean,
      ): Promise<{ ok: false; error: UpstreamError; empty?: boolean }> => {
        await breaker.recordFailure({ circuitTrip: error.circuitTrip });
        return { ok: false, error, empty };
      };
      const { outcome, attempts } = await withRetry(
        async (attempt, signal) => {
          log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
          // totalMs = 单次尝试上限；deadlineMs = 全部尝试上限（signal 由 withRetry 管理）
          const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.totalMs)]);
          try {
            const res = await fetchUpstream(
              url,
              { method: 'POST', headers: authHeaders(input.channel), body: JSON.stringify(body) },
              { connectMs: cfg.timeout.connectMs, signal: totalSignal, allowLocal: cfg.allowLocalUrl },
            );
            if (res.status >= 400) {
              const raw = await readBody(res, { signal: totalSignal });
              return fail(adapter.mapError(res.status, tryParseJson(raw) ?? raw));
            }
            const raw = await readBody(res, { signal: totalSignal });
            if (raw.trim() === '') return fail(emptyError(), true);
            const json = tryParseJson(raw);
            if (json === undefined) return fail(invalidResponseError());
            const usage =
              adapter.extractUsage(json) ?? estimateUsage(body, json, cfg.estimate.charPerToken);
            return { ok: true, value: usage };
          } catch (err) {
            if (signal.aborted) return fail(abortedError());
            if (totalSignal.aborted) return fail(classifyTransportError('timeout'));
            if (err instanceof Error && err.message.includes('body exceeds')) {
              return fail(invalidResponseError());
            }
            if (isUpstreamError(err)) return fail(err);
            return fail(classifyTransportError('network'));
          }
        },
        retryOptions(input.ctx),
        (info) => log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
          code: info.error.code,
        }),
      );

      const durationMs = Date.now() - start;
      if (outcome.ok) {
        await breaker.recordSuccess();
        log.info(`[ai] ${requestId} success attempts=${attempts} usage=`, outcome.value);
        return { status: 'success', usage: outcome.value, durationMs };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${requestId} failed attempts=${attempts}`, { code: error.code, status: error.status });
      return { status: empty ? 'empty' : 'error', error, durationMs };
    },

    async chatStream(input) {
      const start = Date.now();
      const prepared = prepare(input);
      const { requestId } = input.ctx;
      const failEarly = (error: UpstreamError): ChatStreamResult => {
        // 流开始前失败：返回含 OpenAI 兼容错误帧的流 + failed 事件（gateway 统一收敛）
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const frame = JSON.stringify({
              error: {
                code: error.code,
                message: error.message,
                ...(error.status !== undefined ? { status: error.status } : {}),
              },
            });
            controller.enqueue(new TextEncoder().encode(`data: ${frame}\n\n`));
            controller.close();
          },
        });
        return {
          stream,
          onEvent: (cb) => cb({ type: 'failed', requestId, error }),
        };
      };

      if (!prepared.ok) return failEarly(prepared.error);
      const { body, breaker, adapter, key } = prepared;

      if (!(await breaker.canRequest())) {
        const err = circuitOpenError();
        log.error(`[ai] ${requestId} circuit open, rejected (${key})`);
        return failEarly(err);
      }

      const url = joinUrl(input.channel.baseUrl, '/v1/chat/completions');
      const fail = async (
        error: UpstreamError,
      ): Promise<{ ok: false; error: UpstreamError }> => {
        await breaker.recordFailure({ circuitTrip: error.circuitTrip });
        return { ok: false, error };
      };
      const { outcome, attempts } = await withRetry(
        async (attempt, signal) => {
          log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
          try {
            // 流式不用 totalMs（流可持续很久，由 heartbeat/inactivity 管理）；connectMs 已保证首字节
            const res = await fetchUpstream(
              url,
              { method: 'POST', headers: authHeaders(input.channel), body: JSON.stringify(body) },
              { connectMs: cfg.timeout.connectMs, signal, allowLocal: cfg.allowLocalUrl },
            );
            if (res.status >= 400) {
              const raw = await readBody(res, { signal });
              return fail(adapter.mapError(res.status, tryParseJson(raw) ?? raw));
            }
            return { ok: true, value: res };
          } catch (err) {
            if (signal.aborted) return fail(abortedError());
            if (isUpstreamError(err)) return fail(err);
            return fail(classifyTransportError('network'));
          }
        },
        retryOptions(input.ctx),
        (info) => log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
          code: info.error.code,
        }),
      );

      if (!outcome.ok) {
        log.error(`[ai] ${requestId} failed attempts=${attempts}`, {
          code: outcome.error.code,
          status: outcome.error.status,
        });
        return failEarly(outcome.error);
      }
      const res = outcome.value;
      await breaker.recordSuccess();

      // 透传管道：relay 事件 → AiEvent 桥接（done 一定最后发，见 relay-stream）
      const handle = relayStream(res.body!, {
        heartbeatIdleMs: cfg.stream.heartbeatIdleMs,
        inactivityTimeoutMs: cfg.stream.inactivityTimeoutMs,
      });
      const listeners: Array<(e: AiEvent) => void> = [];
      handle.onEvent((e) => {
        switch (e.type) {
          case 'stream_error':
            emitTo(listeners, { type: 'stream_error', requestId, frame: e.frame });
            break;
          case 'aborted':
            emitTo(listeners, { type: 'aborted', requestId, reason: e.reason });
            break;
          case 'done': {
            const usage = e.usage !== null ? normalizeUsage(e.usage) : null;
            if (usage) {
              emitTo(listeners, {
                type: 'usage',
                requestId,
                usage,
                streamError: e.errorFrame ?? undefined,
              });
            } else if (e.errorFrame) {
              log.warn(`[ai] ${requestId} stream ended without usage`, e.errorFrame);
            }
            emitTo(listeners, {
              type: 'success',
              requestId,
              usage: usage ?? undefined,
              durationMs: Date.now() - start,
            });
            break;
          }
        }
      });
      return { stream: handle.stream, onEvent: (cb) => listeners.push(cb) };
    },

    async probe(channel) {
      const start = Date.now();
      const adapter = adapterFor(channel);
      let firstError: UpstreamError | undefined;
      for (const path of adapter.probePaths()) {
        try {
          const res = await fetchUpstream(
            joinUrl(channel.baseUrl, path),
            { method: 'GET', headers: { authorization: `Bearer ${channel.apiKey}` } },
            { connectMs: cfg.timeout.connectMs, allowLocal: cfg.allowLocalUrl },
          );
          if (res.status < 400) return { ok: true, durationMs: Date.now() - start };
          const raw = await readBody(res);
          firstError ??= adapter.mapError(res.status, tryParseJson(raw) ?? raw);
        } catch (err) {
          firstError ??= isUpstreamError(err) ? err : classifyTransportError('network');
        }
      }
      return { ok: false, durationMs: Date.now() - start, error: firstError };
    },
  };
}
