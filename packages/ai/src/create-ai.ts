import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import { AnthropicAdapter } from './adapters/anthropic';
import { GeminiAdapter } from './adapters/gemini';
import { AzureOpenAIAdapter } from './adapters/azure-openai';
import { AwsBedrockAdapter } from './adapters/aws-bedrock';
import { VertexAiAdapter } from './adapters/vertex-ai';
import { MiniMaxAdapter } from './adapters/minimax';
import type { ProtocolAdapter } from './adapters/protocol-adapter';
import { CircuitBreaker } from './breaker/breaker';
import { DeadCredentialTracker } from './dead-credential/tracker';
import { classifyBodyOnlyError, classifyTransportError } from './errors/classify';
import {
  abortedError,
  circuitOpenError,
  deadCredentialError,
  emptyError,
  invalidConfigError,
  invalidResponseError,
  serverDrainingError,
  unsupportedProtocolError,
} from './errors/internal';
import { asServerDrainAbort } from './errors/server-drain';
import { asRecord, tryParseJson } from './internal/util';
import { peekFirstChunk, firstChunkStreamError, PeekTimeoutError } from './internal/stream';
import { BodyTooLargeError, fetchUpstream, readBody, readRawBody } from './transport/http-client';
import { relayStream } from './transport/relay-stream';
import { normalizeUsage } from './usage/normalize';
import { estimateUsage } from './usage/token-estimate';
import { withRetry, type RetryOptions } from './retry/with-retry';
import {
  type AiConfig,
  aiConfigSchema,
  type AiConfigInput,
  type AiDeps,
  type AiOptions,
  type BreakerStorage,
  type DeadCredentialStorage,
} from './config';
import type { AiEvent } from './events';
import type {
  Ai,
  ChannelDesc,
  ChatStreamResult,
  Endpoint,
  RequestCtx,
  UpstreamError,
  Usage,
} from './types';

/**
 * create-ai 组装（ai-package.md §5/§6）：适配器注册表 + withRetry + breaker 绑定 + 事件输出
 *   - 单渠道内重试（withRetry）；换渠道/fallback 模型候选循环是 gateway 的职责
 *   - 熔断按 channelKey（protocol://host）维度，计数只收 circuitTrip=true
 *   - 失败路径双向收敛：非流式返回 ChatResult；流式「流开始前失败」→ 返回含错误帧的流 + failed 事件
 *   - 流式重试仅限首字节前；流开始后失败发错误帧，不重试（由 relay-stream 保证）
 */

const noop = (): void => {};

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
function fireAndForget(p: Promise<unknown>): void {
  p.catch(noop);
}

/**
 * 拼接上游 URL（BUG-E，new-api #3133 同类修复）：baseUrl 尾段是版本段
 * （/v1、/v2…）且与适配器路径首段相同时去重——管理员按 OpenAI 文档惯例填
 * `https://host/v1` 时不得拼出 `/v1/v1/chat/completions`（404 且与配置
 * 根源无关，极难排查）。版本段之外的内容（如 openrouter 的 `/api`）不动。
 */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const versionSeg = /\/(v\d+)(?=\/)/i.exec(path);
  const baseTail = base.split('/').pop() ?? '';
  if (versionSeg && versionSeg[1]!.toLowerCase() === baseTail.toLowerCase()) {
    return base + path.slice(versionSeg[0]!.length);
  }
  return base + path;
}

/**
 * 默认协议注册表（不注入 adapters 时的注册项）。
 * 七个协议族：openai-compatible（含全部 OpenAI 兼容厂商）+ 五个原生协议
 * + minimax（任务族 video/music + MiniMax chat 兼容）。
 */
const defaultAdapters: ProtocolAdapter[] = [
  new OpenAICompatibleAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  new AzureOpenAIAdapter(),
  new AwsBedrockAdapter(),
  new VertexAiAdapter(),
  new MiniMaxAdapter(),
];

/** 默认注册表键——协议词表的单一真相（admin 配置面校验引用此处，不再各自枚举） */
export const SUPPORTED_PROTOCOLS: readonly string[] = defaultAdapters.map((a) => a.protocol);

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

export function createAi(config: AiConfigInput, deps: AiDeps, options?: AiOptions): Ai {
  const cfg: AiConfig = aiConfigSchema.parse(config ?? {});
  const breakerStorage: BreakerStorage = deps.breakerStorage;
  const deadCredentialStorage: DeadCredentialStorage = deps.deadCredentialStorage;
  const log = deps?.logger ?? { info: noop, warn: noop, error: noop };

  // 全局事件总线（chat + chatStream 共用；gateway 订阅用于计量/排障/候选循环）
  const listeners: Array<(e: AiEvent) => void> = [];
  const emit = (e: AiEvent): void => emitTo(listeners, e);

  // 协议注册表（注册即扩展）：默认仅 openai-compatible；传入则整体替换（显式优先）。
  // 同键重复注册启动即抛——一个协议两个实现 = 双真相，必须在结构上杜绝。
  const adapters = new Map<string, ProtocolAdapter>();
  for (const adapter of options?.adapters ?? defaultAdapters) {
    if (adapters.has(adapter.protocol)) {
      throw new Error(`duplicate protocol adapter registration: ${adapter.protocol}`);
    }
    adapters.set(adapter.protocol, adapter);
  }
  // 未知协议显式报错（不静默回退 openai-compatible——配置错误必须可发现）
  const resolveAdapter = (channel: ChannelDesc): ProtocolAdapter | UpstreamError =>
    adapters.get(channel.protocol) ??
    unsupportedProtocolError(channel.protocol, [...adapters.keys()]);

  const breakerFor = (channel: ChannelDesc): CircuitBreaker =>
    new CircuitBreaker(channelKey(channel), cfg.breaker, breakerStorage, Date.now);

  const credentialFor = (channel: ChannelDesc): DeadCredentialTracker =>
    new DeadCredentialTracker(
      channelKey(channel),
      cfg.deadCredential,
      deadCredentialStorage,
      Date.now,
    );

  /** 组装 per-request 上下文：参数抹平 + 熔断/凭据准入，返回失败则返回 ChatResult 错误分支 */
  function prepare(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }):
    | {
        ok: true;
        body: unknown;
        breaker: CircuitBreaker;
        credential: DeadCredentialTracker;
        adapter: ProtocolAdapter;
        key: string;
      }
    | { ok: false; error: UpstreamError } {
    // 配置校验（fail fast）：必需字段为空时直接返回错误，不发垃圾请求
    const cfgErr = assertChannelAndCtx(input.channel, input.ctx);
    if (cfgErr) return { ok: false, error: cfgErr };
    const adapter = resolveAdapter(input.channel);
    if (isUpstreamError(adapter)) return { ok: false, error: adapter };
    // 参数抹平规则唯一来源：DB param_rules（per-model），无 provider 内置默认
    const rules = input.ctx.paramRules ?? {};
    const { body, adjustments } = adapter.normalizeRequest(input.request, rules);
    // model 重写与 stream_options 注入等协议特定终改由 adapter.finalizeRequestBody
    // 在发往上游前完成（chat/chatStream 入口调用），编排层不再出现协议字面量。
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
      signal: ctx.signal,
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

      // 上游寻址 + 请求体终改：全部由协议适配器决定（路径/认证头/model 重写）
      const endpoint: Endpoint = input.ctx.endpoint ?? 'chat';
      const plan = adapter.planRequest(input.channel, {
        endpoint,
        model: input.ctx.model,
        requestId,
        stream: false,
      });
      const url = joinUrl(input.channel.baseUrl, plan.path);
      const rec = asRecord(body);
      const finalBody = rec
        ? adapter.finalizeRequestBody(rec, { endpoint, model: input.ctx.model, stream: false })
        : body;
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
        async (attempt, signal): Promise<
          | { ok: false; error: UpstreamError; empty?: boolean }
          | { ok: true; value: { usage?: Usage; durationMs?: never; body?: unknown; rawBody?: Uint8Array; rawContentType?: string } }
        > => {
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
              ? { ...plan.headers, ...await adapter.signRequest({ url: new URL(url), body: serializedBody, apiKey: input.channel.apiKey, amzDate: new Date() }) }
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
                providerName: input.ctx.providerName,
                model: input.ctx.model,
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
        },
        retryOptions(input.ctx),
        (info) =>
          log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
            code: info.error.code,
          }),
      );

      const durationMs = Date.now() - start;
      if (outcome.ok) {
        await breaker.recordSuccess();
        await credential.recordSuccess();
        log.info(`[ai] ${requestId} success attempts=${attempts} usage=`, outcome.value.usage);
        emit({
          type: 'success',
          requestId,
          channelKey: key,
          usage: outcome.value.usage,
          durationMs,
        });
        return {
          status: 'success',
          usage: outcome.value.usage,
          body: outcome.value.body,
          durationMs,
        };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${requestId} failed attempts=${attempts}`, {
        code: error.code,
        status: error.status,
      });
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

      // 上游寻址 + 请求体终改（含 stream_options 强制注入——见 OpenAICompatibleAdapter.finalizeRequestBody）
      const endpoint: Endpoint = input.ctx.endpoint ?? 'chat';
      const plan = adapter.planRequest(input.channel, {
        endpoint,
        model: input.ctx.model,
        requestId,
        stream: true,
      });
      const url = joinUrl(input.channel.baseUrl, plan.path);
      const rec = asRecord(body);
      const finalBody = rec
        ? adapter.finalizeRequestBody(rec, { endpoint, model: input.ctx.model, stream: true })
        : body;
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
            const serializedBody = JSON.stringify(finalBody);
            const signedHeaders = adapter.signRequest
              ? { ...plan.headers, ...await adapter.signRequest({ url: new URL(url), body: serializedBody, apiKey: input.channel.apiKey, amzDate: new Date() }) }
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
              ? adapter.translateUpstreamStream(res.body, input.ctx.model)
              : res.body;
            // 缓冲根因（bodyLimit + requestLog clone）已修复，tee 不再导致缓冲
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
        },
        retryOptions(input.ctx),
        (info) =>
          log.warn(`[ai] ${requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
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
        signal: input.ctx.signal,
      });
      // 拿到首帧才算成功
      // 熔断/死凭据状态写入是 best-effort：不阻塞数据流，且吞掉存储错误
      // （Redis 宕机时 fireAndForget 防 unhandledRejection 崩进程）
      fireAndForget(breaker.recordSuccess());
      fireAndForget(credential.recordSuccess());
      handle.onEvent((e) => {
        switch (e.type) {
          case 'first_chunk':
            // TTFB 权威观察点：上游首字节流向客户端（一次性），转发给晚订阅的消费方
            emitStream({ type: 'first_chunk', requestId });
            break;
          case 'stream_error':
            emitStream({ type: 'stream_error', requestId, frame: e.frame });
            break;
          case 'aborted':
            emitStream({ type: 'aborted', requestId, reason: e.reason });
            // B6：非客户端断开 → 计入熔断（渠道故障或协议错误）
            // client_disconnect 是用户主动断开，server_draining 是本服务停机，
            // 均非渠道问题，不计熔断
            if (e.reason !== 'client_disconnect' && e.reason !== 'server_draining') {
              fireAndForget(breaker.recordFailure({ circuitTrip: true }));
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
              outputText: e.outputText,
              doneSentinel: e.doneSentinel,
              terminalFrame: e.terminalFrame,
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
      const adapter = resolveAdapter(channel);
      if (isUpstreamError(adapter)) return { ok: false, durationMs: 0, error: adapter };
      let firstError: UpstreamError | undefined;
      // 死凭据优先：即使先遇到网络错误，只要任一路径返回 401/403（死凭据），
      // 最终返回死凭据——连通性测试的核心目的是验证 Key 是否有效
      let deadCredError: UpstreamError | undefined;
      const probes = adapter.probeRequests(channel);
      // 无廉价无副作用探测的协议（bedrock 等）返回空表：探测是尽力而为，跳过=通过
      if (probes.length === 0) return { ok: true, durationMs: Date.now() - start };
      for (const probe of probes) {
        try {
          const res = await fetchUpstream(
            joinUrl(channel.baseUrl, probe.path),
            { method: 'GET', headers: probe.headers },
            {
              connectMs: cfg.timeout.connectMs,
              allowLocal: cfg.allowLocalUrl,
              allowedHosts: cfg.allowedHosts,
            },
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

    // ---- 异步生成任务操作面（仅 tasks 适配器提供；轮询为周期性只读，不进重试/熔断）----

    parseGenerationResponse(input) {
      const adapter = resolveAdapter(input.channel);
      if (isUpstreamError(adapter)) return { kind: 'error', error: adapter };
      const tasks = adapter.tasks;
      if (!tasks) {
        return {
          kind: 'error',
          error: unsupportedProtocolError(input.channel.protocol, [...adapters.keys()]),
        };
      }
      return tasks.parseResponse(input.endpoint, input.body);
    },

    async queryGenerationTask(input) {
      const adapter = resolveAdapter(input.channel);
      if (isUpstreamError(adapter)) return { ok: false, error: adapter };
      const tasks = adapter.tasks;
      if (!tasks) {
        return {
          ok: false,
          error: unsupportedProtocolError(input.channel.protocol, [...adapters.keys()]),
        };
      }
      const plan = tasks.planTaskQuery(input.channel, input.taskId);
      try {
        const res = await fetchUpstream(
          joinUrl(input.channel.baseUrl, plan.path),
          { method: 'GET', headers: plan.headers },
          {
            connectMs: cfg.timeout.connectMs,
            allowLocal: cfg.allowLocalUrl,
            allowedHosts: cfg.allowedHosts,
          },
        );
        if (res.status >= 400) {
          const raw = await readBody(res);
          return { ok: false, error: adapter.mapError(res.status, tryParseJson(raw) ?? raw) };
        }
        const raw = await readBody(res);
        return tasks.parseTaskStatus(tryParseJson(raw));
      } catch (err) {
        // 轮询是周期性的：瞬时网络错误归 error，调用方下轮再查（不重试单次）
        return {
          ok: false,
          error: isUpstreamError(err) ? err : classifyTransportError('network'),
        };
      }
    },

    async retrieveGenerationFile(input) {
      const adapter = resolveAdapter(input.channel);
      if (isUpstreamError(adapter)) return { ok: false, error: adapter };
      const tasks = adapter.tasks;
      if (!tasks?.planFileRetrieve || !tasks.parseFileRetrieve) {
        return {
          ok: false,
          error: unsupportedProtocolError(input.channel.protocol, [...adapters.keys()]),
        };
      }
      const plan = tasks.planFileRetrieve(input.channel, input.fileId);
      try {
        const res = await fetchUpstream(
          joinUrl(input.channel.baseUrl, plan.path),
          { method: 'GET', headers: plan.headers },
          {
            connectMs: cfg.timeout.connectMs,
            allowLocal: cfg.allowLocalUrl,
            allowedHosts: cfg.allowedHosts,
          },
        );
        if (res.status >= 400) {
          const raw = await readBody(res);
          return { ok: false, error: adapter.mapError(res.status, tryParseJson(raw) ?? raw) };
        }
        const raw = await readBody(res);
        return tasks.parseFileRetrieve(tryParseJson(raw));
      } catch (err) {
        return {
          ok: false,
          error: isUpstreamError(err) ? err : classifyTransportError('network'),
        };
      }
    },
  };
}
