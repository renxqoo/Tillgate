import { OpenAICompatibleAdapter } from './adapters/openai-compatible.js';
import { loadProfile, mergeRules } from './adapters/profiles/index.js';
import type { ProtocolAdapter } from './adapters/protocol-adapter.js';
import { CircuitBreaker } from './breaker/breaker.js';
import { MemoryBreakerStorage } from './breaker/memory-storage.js';
import { MemoryDeadCredentialStorage } from './dead-credential/memory-storage.js';
import { DeadCredentialTracker } from './dead-credential/tracker.js';
import { classifyTransportError } from './errors/classify.js';
import {
  abortedError,
  circuitOpenError,
  deadCredentialError,
  emptyError,
  invalidConfigError,
  invalidResponseError,
} from './errors/internal.js';
import { asRecord, tryParseJson } from './internal/util.js';
import { peekFirstChunk } from './internal/stream.js';
import { BodyTooLargeError, fetchUpstream, readBody } from './transport/http-client.js';
import { relayStream } from './transport/relay-stream.js';
import { estimateUsage, normalizeUsage } from './usage/normalize.js';
import { withRetry, type RetryOptions } from './retry/with-retry.js';
import { defaultAiConfig, type AiConfig, type AiDeps, type BreakerStorage, type DeadCredentialStorage } from './config.js';
import type { AiEvent } from './events.js';
import type {
  Ai,
  ChannelDesc,
  ChatStreamResult,
  RequestCtx,
  UpstreamError,
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

/**
 * 配置校验（fail fast）：apiKey/baseUrl/protocol/model/requestId 必需且非空。
 * 空值返回 invalidConfigError（不发垃圾请求——空 key 会拼出无效 Authorization，错误信息不清晰）。
 */
function assertChannelAndCtx(channel: ChannelDesc, ctx: RequestCtx): UpstreamError | null {
  if (!channel.apiKey) return invalidConfigError('channel.apiKey 为空');
  if (!channel.baseUrl) return invalidConfigError('channel.baseUrl 为空');
  if (!channel.protocol) return invalidConfigError('channel.protocol 为空');
  if (!ctx.model) return invalidConfigError('ctx.model 为空（真实模型名缺失）');
  if (!ctx.requestId) return invalidConfigError('ctx.requestId 为空（幂等键缺失）');
  return null;
}

/** probe 只校验 channel（无 ctx） */
function assertChannel(channel: ChannelDesc): UpstreamError | null {
  if (!channel.apiKey) return invalidConfigError('channel.apiKey 为空');
  if (!channel.baseUrl) return invalidConfigError('channel.baseUrl 为空');
  if (!channel.protocol) return invalidConfigError('channel.protocol 为空');
  return null;
}

function isUpstreamError(e: unknown): e is UpstreamError {
  return (
    e instanceof Error &&
    typeof (e as UpstreamError).code === 'string' &&
    typeof (e as UpstreamError).retryable === 'boolean'
  );
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
  const deadCredentialStorage: DeadCredentialStorage =
    deps?.deadCredentialStorage ?? new MemoryDeadCredentialStorage();
  const log = deps?.logger ?? { info: noop, warn: noop, error: noop };

  // 全局事件总线（chat + chatStream 共用；gateway 订阅用于计量/排障/候选循环）
  const listeners: Array<(e: AiEvent) => void> = [];
  const emit = (e: AiEvent): void => emitTo(listeners, e);

  const adapters = new Map<string, ProtocolAdapter>([
    ['openai-compatible', new OpenAICompatibleAdapter()],
  ]);
  const adapterFor = (channel: ChannelDesc): ProtocolAdapter =>
    adapters.get(channel.protocol) ?? adapters.get('openai-compatible')!;

  const breakerFor = (channel: ChannelDesc): CircuitBreaker =>
    new CircuitBreaker(channelKey(channel), cfg.breaker, breakerStorage, Date.now);

  const credentialFor = (channel: ChannelDesc): DeadCredentialTracker =>
    new DeadCredentialTracker(channelKey(channel), cfg.deadCredential, deadCredentialStorage, Date.now);

  /** 组装 per-request 上下文：参数抹平 + 熔断/凭据准入，返回失败则返回 ChatResult 错误分支 */
  function prepare(input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: RequestCtx;
  }): {
    ok: true;
    body: unknown;
    breaker: CircuitBreaker;
    credential: DeadCredentialTracker;
    adapter: ProtocolAdapter;
    key: string;
  } | { ok: false; error: UpstreamError } {
    // 配置校验（fail fast）：必需字段为空时直接返回错误，不发垃圾请求
    const cfgErr = assertChannelAndCtx(input.channel, input.ctx);
    if (cfgErr) return { ok: false, error: cfgErr };
    const adapter = adapterFor(input.channel);
    const rules = mergeRules(loadProfile(input.ctx.providerName), input.ctx.paramRules);
    const { body, adjustments } = adapter.normalizeRequest(input.request, rules);
    for (const a of adjustments) {
      log.info(`[ai] ${input.ctx.requestId} param_adjustment ${a.action} ${a.param}`, {
        from: a.from,
        to: a.to,
      });
      // B4：参数抹平产出 param_adjustment 事件（gateway 排障可观测）
      emit({
        type: 'param_adjustment',
        requestId: input.ctx.requestId,
        param: a.param,
        action: a.action,
        from: a.from,
        to: a.to,
      });
    }
    return {
      ok: true,
      body,
      breaker: breakerFor(input.channel),
      credential: credentialFor(input.channel),
      adapter,
      key: channelKey(input.channel),
    };
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
      const { body, breaker, credential, adapter, key } = prepared;
      const { requestId } = input.ctx;

      if (!(await breaker.canRequest())) {
        const err = circuitOpenError();
        log.error(`[ai] ${requestId} circuit open, rejected (${key})`);
        emit({ type: 'failed', requestId, channelKey: key, error: err });
        return { status: 'error', error: err, durationMs: Date.now() - start };
      }
      // 死凭据准入：invalid 渠道停止路由（gateway 路由层跳过，等人工换 Key）
      if (!(await credential.canRequest())) {
        const err = deadCredentialError();
        log.error(`[ai] ${requestId} dead credential, rejected (${key})`);
        emit({ type: 'failed', requestId, channelKey: key, error: err });
        return { status: 'error', error: err, durationMs: Date.now() - start };
      }

      // endpoint 选择：embeddings 走 /v1/embeddings，默认 chat
      const endpointPath = input.ctx.endpoint === 'embeddings' ? '/v1/embeddings' : '/v1/chat/completions';
      const url = joinUrl(input.channel.baseUrl, endpointPath);
      // 每次尝试失败即计熔断数（429/4xx/死凭据 circuitTrip=false 自动不计）+ 死凭据计数
      const fail = async (
        error: UpstreamError,
        empty?: boolean,
      ): Promise<{ ok: false; error: UpstreamError; empty?: boolean }> => {
        await breaker.recordFailure({ circuitTrip: error.circuitTrip });
        // 死凭据失败（401/403 + 特征）→ 计数；达阈值后续请求被 credential.canRequest 拒绝
        if (error.deadCredential) await credential.recordFailure({ deadCredential: true });
        return { ok: false, error, empty };
      };
      const { outcome, attempts } = await withRetry(
        async (attempt, signal) => {
          log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
          // B4：每次尝试发 attempt_start（gateway 知道第几次尝试、打到哪个渠道）
          emit({ type: 'attempt_start', requestId, channelKey: key, attempt });
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
            return { ok: true, value: { usage, body: json } };
          } catch (err) {
            if (signal.aborted) return fail(abortedError());
            if (totalSignal.aborted) return fail(classifyTransportError('timeout'));
            if (err instanceof BodyTooLargeError) {
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
        await credential.recordSuccess();
        log.info(`[ai] ${requestId} success attempts=${attempts} usage=`, outcome.value.usage);
        emit({ type: 'success', requestId, channelKey: key, usage: outcome.value.usage, durationMs });
        return { status: 'success', usage: outcome.value.usage, body: outcome.value.body, durationMs };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${requestId} failed attempts=${attempts}`, { code: error.code, status: error.status });
      if (empty) {
        emit({ type: 'empty_completion', requestId, channelKey: key, attempt: attempts });
      } else {
        emit({ type: 'failed', requestId, channelKey: key, error });
      }
      return { status: empty ? 'empty' : 'error', error, durationMs };
    },

    async chatStream(input) {
      const start = Date.now();
      const prepared = prepare(input);
      const { requestId } = input.ctx;
      const key = prepared.ok ? prepared.key : 'unknown';
      // per-call 订阅（ChatStreamResult.onEvent）；与全局 emit 同时通知
      const perCallListeners: Array<(e: AiEvent) => void> = [];
      // 终态事件缓冲：onEvent 注册晚于事件发出时（failEarly/empty 在返回 handle 前同步发），
      // 注册时重放，保证调用方不丢失终态事件
      const lateEvents: AiEvent[] = [];
      const emitStream = (e: AiEvent): void => {
        emit(e); // 全局总线（gateway 计量/排障）
        emitTo(perCallListeners, e); // 本次流专用回调
      };
      /** 发送终态事件（同步确定，早于 handle 返回）：推全局 + 缓冲供 onEvent 重放 */
      const emitTerminal = (e: AiEvent): void => {
        emit(e);
        lateEvents.push(e);
      };
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
        emitTerminal({ type: 'failed', requestId, channelKey: key, error });
        return {
          stream,
          onEvent: (cb) => {
            perCallListeners.push(cb);
            // 重放已发出的终态事件（failed / 之前的 empty_completion）
            for (const ev of lateEvents) cb(ev);
          },
        };
      };

      if (!prepared.ok) return failEarly(prepared.error);
      const { body, breaker, credential, adapter } = prepared;

      // 流式自动注入 stream_options.include_usage（用户未显式设置时）：
      // MiniMax/OpenAI 流式需该字段才在尾帧发 usage，不注入则全程 usage:null
      // → gateway 只能按 bytesRelayed 粗估（漏计费/估算偏差）。
      // DeepSeek 默认就发 usage，注入无副作用；用户显式设置则尊重不覆盖。
      const streamBody = (asRecord(body) ?? {}) as Record<string, unknown>;
      if (streamBody.stream_options === undefined) {
        streamBody.stream_options = { include_usage: true };
      }

      if (!(await breaker.canRequest())) {
        const err = circuitOpenError();
        log.error(`[ai] ${requestId} circuit open, rejected (${key})`);
        return failEarly(err);
      }
      if (!(await credential.canRequest())) {
        const err = deadCredentialError();
        log.error(`[ai] ${requestId} dead credential, rejected (${key})`);
        return failEarly(err);
      }

      const url = joinUrl(input.channel.baseUrl, '/v1/chat/completions');
      const fail = async (
        error: UpstreamError,
        empty?: boolean,
      ): Promise<{ ok: false; error: UpstreamError; empty?: boolean }> => {
        await breaker.recordFailure({ circuitTrip: error.circuitTrip });
        if (error.deadCredential) await credential.recordFailure({ deadCredential: true });
        return { ok: false, error, empty };
      };
      const { outcome, attempts } = await withRetry(
        async (attempt, signal) => {
          log.info(`[ai] ${requestId} attempt ${attempt} (${key})`);
          emit({ type: 'attempt_start', requestId, channelKey: key, attempt });
          try {
            // 流式不用 totalMs（流可持续很久，由 heartbeat/inactivity 管理）；connectMs 保证连接
            const res = await fetchUpstream(
              url,
              { method: 'POST', headers: authHeaders(input.channel), body: JSON.stringify(body) },
              { connectMs: cfg.timeout.connectMs, signal, allowLocal: cfg.allowLocalUrl },
            );
            if (res.status >= 400) {
              const raw = await readBody(res, { signal });
              return fail(adapter.mapError(res.status, tryParseJson(raw) ?? raw));
            }
            if (!res.body) return fail(invalidResponseError());
            // D3：空流检测（tee 分流，不破坏流式）
            // 缓冲根因（bodyLimit + requestLog clone）已修复，tee 不再导致缓冲
            const peeked = await peekFirstChunk(res.body, { signal });
            if (peeked.done) return fail(emptyError(), true);
            return { ok: true, value: peeked.rest! };
          } catch (err) {
            if (signal.aborted) return fail(abortedError());
            if (err instanceof BodyTooLargeError) return fail(invalidResponseError());
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
        const { error, empty } = outcome;
        log.error(`[ai] ${requestId} failed attempts=${attempts}`, {
          code: error.code,
          status: error.status,
        });
        if (empty) {
          // 流式空完成重试耗尽：发 empty_completion（gateway 换渠道），不计费（5.11 全程无输出）
          // failed 由 failEarly 统一发，这里只补 empty 语义事件
          emitTerminal({ type: 'empty_completion', requestId, channelKey: key, attempt: attempts });
        }
        return failEarly(error);
      }
      const rest = outcome.value;
      // 先创建 relayStream（立即开始消费上游数据，防缓冲区堆积），
      // breaker/credential 的 Redis 写入在后面做（不阻塞数据流）
      const handle = relayStream(rest, {
        heartbeatIdleMs: cfg.stream.heartbeatIdleMs,
        inactivityTimeoutMs: cfg.stream.inactivityTimeoutMs,
      });
      // 拿到首帧才算成功
      void breaker.recordSuccess();
      void credential.recordSuccess();
      handle.onEvent((e) => {
        switch (e.type) {
          case 'stream_error':
            emitStream({ type: 'stream_error', requestId, frame: e.frame });
            break;
          case 'aborted':
            emitStream({ type: 'aborted', requestId, reason: e.reason });
            // B6：非客户端断开 → 计入熔断（渠道故障：inactivity/upstream_disconnected）
            // client_disconnect 是用户主动断开，非渠道问题，不计熔断
            if (e.reason !== 'client_disconnect') {
              void breaker.recordFailure({ circuitTrip: true });
            }
            break;
          case 'done': {
            const usage = e.usage !== null ? normalizeUsage(e.usage) : null;
            if (usage) {
              emitStream({
                type: 'usage',
                requestId,
                usage,
                streamError: e.errorFrame ?? undefined,
              });
            } else if (e.errorFrame) {
              log.warn(`[ai] ${requestId} stream ended without usage`, e.errorFrame);
            }
            // B2：把 terminated + bytesRelayed 带到 success（gateway 据此判定 stream_aborted + 估算）
            emitStream({
              type: 'success',
              requestId,
              channelKey: key,
              usage: usage ?? undefined,
              durationMs: Date.now() - start,
              terminated: e.terminated,
              bytesRelayed: e.bytesRelayed,
            });
            break;
          }
        }
      });
      return { stream: handle.stream, onEvent: (cb) => perCallListeners.push(cb) };
    },

    async probe(channel) {
      const start = Date.now();
      // 配置校验（fail fast）：空 apiKey/baseUrl 不发垃圾请求
      const cfgErr = assertChannel(channel);
      if (cfgErr) return { ok: false, durationMs: 0, error: cfgErr };
      const adapter = adapterFor(channel);
      let firstError: UpstreamError | undefined;
      // 死凭据优先：即使先遇到网络错误，只要任一路径返回 401/403（死凭据），
      // 最终返回死凭据——连通性测试的核心目的是验证 Key 是否有效
      let deadCredError: UpstreamError | undefined;
      for (const path of adapter.probePaths()) {
        try {
          const res = await fetchUpstream(
            joinUrl(channel.baseUrl, path),
            { method: 'GET', headers: { authorization: `Bearer ${channel.apiKey}` } },
            { connectMs: cfg.timeout.connectMs, allowLocal: cfg.allowLocalUrl },
          );
          if (res.status < 400) return { ok: true, durationMs: Date.now() - start };
          const raw = await readBody(res);
          const err = adapter.mapError(res.status, tryParseJson(raw) ?? raw);
          if (err.deadCredential) deadCredError ??= err;
          else firstError ??= err;
        } catch (err) {
          const mapped = isUpstreamError(err) ? err : classifyTransportError('network');
          firstError ??= mapped;
        }
      }
      return {
        ok: false,
        durationMs: Date.now() - start,
        error: deadCredError ?? firstError,
      };
    },

    onEvent(cb) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}
