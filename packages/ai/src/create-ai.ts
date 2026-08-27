/**
 * createAi 装配壳（平参数 API）：
 *   chat(channel, request, opts) / chatStream / use / subscribe / probe / tasks
 * 机制链：参数抹平 → 单次尝试体（withRetry 包裹）→ relay 透传 + 事件观察面。
 * 单渠道内重试；换渠道候选循环是 inference 的职责。
 * 尝试执行体（chat/stream）与任务操作组住在 pipeline/attempt-*.ts、pipeline/tasks.ts。
 */
import type {
  Ai,
  CallOptions,
  ChannelClient,
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  ProbeResult,
  UpstreamError,
} from './types';
import type { AiDefaults, AiDeps, AiDefaultsInput, AiOptions } from './config';
import { aiDefaultsSchema } from './config';
import type { ProtocolAdapter } from './adapters/protocol-adapter';
import type { AiEvent } from './events';
import { UpstreamError as UE } from './errors/kinds';
import { invalidConfigError, unsupportedProtocolError } from './errors/internal';
import { sanitizeUpstreamDetail } from './errors/sanitize';
import { fetchUpstream, readBody } from './transport/http-client';
import { relayStream } from './transport/relay-stream';
import { withRetry } from './retry/with-retry';
import { resolveVendorProfile, mergeParamRules } from './registry/vendor-profiles';
import { channelKey, assertChannel, emitTo, type CallCtx } from './pipeline/context';
import {
  createStreamEventBus,
  failEarlyStream,
  attachRelayReporting,
} from './pipeline/stream-report';
import { chatAttempt, type ChatAttemptValue } from './pipeline/attempt-chat';
import { streamAttempt } from './pipeline/attempt-stream';
import { createTaskOps } from './pipeline/tasks';
import { tryParseJson } from './internal/json';
import { joinUrl } from './join-url';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import { AnthropicAdapter } from './adapters/anthropic';
import { GeminiAdapter } from './adapters/gemini';
import { AzureOpenAIAdapter } from './adapters/azure-openai';
import { AwsBedrockAdapter } from './adapters/aws-bedrock';
import { VertexAiAdapter } from './adapters/vertex-ai';
import { MiniMaxAdapter } from './adapters/minimax';
import { DashScopeAdapter } from './adapters/dashscope';

const randomId = (): string => crypto.randomUUID();

const defaultAdapters: ProtocolAdapter[] = [
  new OpenAICompatibleAdapter(),
  new AnthropicAdapter(),
  new GeminiAdapter(),
  AzureOpenAIAdapter,
  new AwsBedrockAdapter(),
  new VertexAiAdapter(),
  new MiniMaxAdapter(),
  new DashScopeAdapter(),
];

export const SUPPORTED_PROTOCOLS: readonly string[] = defaultAdapters.map((a) => a.protocol);

// eslint-disable-next-line max-lines-per-function -- 装配根（create-ai 拆出 attempt-chat/attempt-stream/tasks/stream-report 后的剩余装配 + 两个 API 动词），拆分需跨闭包线程化十余项装配状态
export function createAi(defaults?: AiDefaultsInput, deps: AiDeps = {}, options?: AiOptions): Ai {
  const cfg: AiDefaults = aiDefaultsSchema.parse(defaults ?? {});
  const log = deps.logger ?? { info: (): void => {}, warn: (): void => {}, error: (): void => {} };
  const guard = deps.guardUrl;

  const listeners: Array<(e: AiEvent) => void> = [];
  const emit = (e: AiEvent): void => emitTo(listeners, e);

  const adapters = new Map<string, ProtocolAdapter>();
  for (const adapter of options?.adapters ?? defaultAdapters) {
    if (adapters.has(adapter.protocol)) {
      throw new Error(`duplicate protocol adapter registration: ${adapter.protocol}`);
    }
    adapters.set(adapter.protocol, adapter);
  }
  const resolveAdapter = (channel: ChannelDesc): ProtocolAdapter | UpstreamError =>
    adapters.get(channel.protocol) ??
    unsupportedProtocolError(channel.protocol, [...adapters.keys()]);

  // eslint-disable-next-line complexity -- 请求装配校验（渠道/模型/ctx 平铺），分支为显式校验矩阵
  const assembleCtx = (
    channel: ChannelDesc,
    request: unknown,
    opts?: CallOptions,
  ): { ctx: CallCtx } | { error: UpstreamError } => {
    const cfgErr = assertChannel(channel);
    if (cfgErr) return { error: invalidConfigError(cfgErr) };
    const rec =
      typeof request === 'object' && request !== null && !Array.isArray(request)
        ? (request as Record<string, unknown>)
        : null;
    const model = opts?.model ?? (typeof rec?.model === 'string' && rec.model ? rec.model : '');
    if (!model) {
      return {
        error: invalidConfigError(
          'model is required (request.model or opts.model must be provided)',
        ),
      };
    }
    if (
      opts?.endpoint &&
      opts.endpoint !== 'chat' &&
      opts.endpoint !== 'video' &&
      opts.endpoint !== 'music'
    ) {
      const a = adapters.get(channel.protocol);
      if (a && !a.supportedEndpoints.includes(opts.endpoint)) {
        return {
          error: invalidConfigError(
            `protocol ${channel.protocol} does not support endpoint ${opts.endpoint} (supported: ${a.supportedEndpoints.join(',')})`,
          ),
        };
      }
    }
    return {
      ctx: {
        requestId: opts?.requestId ?? randomId(),
        model,
        endpoint: opts?.endpoint ?? 'chat',
        providerName: opts?.providerName,
        paramRules: opts?.paramRules,
        maxRetries: opts?.maxRetries,
        deadlineMs: opts?.deadlineMs,
        signal: opts?.signal,
      },
    };
  };

  const prepareBody = (input: {
    channel: ChannelDesc;
    request: unknown;
    ctx: CallCtx;
    adapter: ProtocolAdapter;
    stream: boolean;
  }) => {
    const { channel, request, ctx, adapter, stream } = input;
    const profile = resolveVendorProfile(channel.vendor);
    const rules = mergeParamRules(profile?.params, ctx.paramRules);
    const { body, adjustments } = adapter.normalizeRequest(request, rules, ctx.endpoint);
    for (const a of adjustments) {
      log.info(`[ai] ${ctx.requestId} param_adjustment ${a.action} ${a.param}`, {
        from: a.from,
        to: a.to,
      });
      emit({
        type: 'param_adjustment',
        requestId: ctx.requestId,
        param: a.param,
        action: a.action,
        from: a.from,
        to: a.to,
      });
    }
    const rec =
      typeof body === 'object' && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    // 裸 FormData 请求（normalizeRequest 的直通契约）不能落入
    // finalizeRequestBody 的 {...form} 展开——multipart 字节会被静默毁成 {model}；
    // FormData 终态与 upstreamForm 包装形同语义：原样透传，仅重写 model 字段。
    const bareForm =
      typeof FormData !== 'undefined' && body instanceof FormData ? (body as FormData) : null;
    const wrappedForm =
      rec !== null && rec.upstreamForm instanceof FormData ? (rec.upstreamForm as FormData) : null;
    const form = wrappedForm ?? bareForm;
    if (form !== null && form.has('model')) {
      form.set('model', ctx.model); // 对外名 → 真实名（与 JSON 路径同语义）
    }
    const finalBody =
      form ??
      (rec
        ? adapter.finalizeRequestBody(rec, { endpoint: ctx.endpoint, model: ctx.model, stream })
        : body);
    return finalBody;
  };

  const retryOpts = (ctx: CallCtx) => ({
    maxAttempts: ctx.maxRetries ?? cfg.retry.maxAttempts,
    baseDelayMs: cfg.retry.baseDelayMs,
    maxDelayMs: cfg.retry.maxDelayMs,
    jitterRatio: cfg.retry.jitterRatio,
    deadlineMs: ctx.deadlineMs ?? cfg.retry.deadlineMs,
    emptyCompletionRetries: cfg.retry.emptyCompletionRetries,
    signal: ctx.signal,
  });

  const ai: Ai = {
    SUPPORTED_PROTOCOLS,

    // eslint-disable-next-line max-lines-per-function -- API 动词：装配 → 重试编排 → 结果归一的直线流程，拆分需传递十余项闭包装配态
    async chat(channel, request, opts): Promise<ChatResult> {
      const start = Date.now();
      const assembled = assembleCtx(channel, request, opts);
      if ('error' in assembled) return { ok: false, error: assembled.error, durationMs: 0 };
      const { ctx } = assembled;
      const key = channelKey(channel);
      const adapter = resolveAdapter(channel);
      if (adapter instanceof UE) {
        return { ok: false, error: adapter, durationMs: Date.now() - start };
      }
      const finalBody = prepareBody({ channel, request, ctx, adapter, stream: false });
      const plan = adapter.planRequest(channel, {
        endpoint: ctx.endpoint,
        model: ctx.model,
        requestId: ctx.requestId,
        stream: false,
      });
      const url = joinUrl(channel.baseUrl, plan.path);

      const { outcome, attempts } = await withRetry<ChatAttemptValue>(
        (attempt, signal) =>
          chatAttempt(
            {
              adapter,
              channel,
              url,
              headers: plan.headers,
              finalBody,
              ctx,
              cfg,
              guard,
              log,
              key,
              emit,
            },
            attempt,
            signal,
          ),
        retryOpts(ctx),
        (info) =>
          log.warn(`[ai] ${ctx.requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, {
            kind: info.error.kind,
          }),
      );

      const durationMs = Date.now() - start;
      if (outcome.ok) {
        log.info(`[ai] ${ctx.requestId} success attempts=${attempts}`);
        emit({
          type: 'success',
          requestId: ctx.requestId,
          channelKey: key,
          usage: outcome.value.usage,
          durationMs,
        });
        return {
          ok: true,
          usage: outcome.value.usage,
          body: outcome.value.body,
          rawBody: outcome.value.rawBody,
          rawContentType: outcome.value.rawContentType,
          durationMs,
        };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${ctx.requestId} failed attempts=${attempts}`, {
        kind: error.kind,
        status: error.status,
      });
      if (empty) {
        emit({
          type: 'empty_completion',
          requestId: ctx.requestId,
          channelKey: key,
          attempt: attempts,
        });
      } else emit({ type: 'failed', requestId: ctx.requestId, channelKey: key, error });
      // 出站错误脱敏：返回值的 message 脱敏、rawBody 保真——
      // 事件面（上方 emit）与日志携带原始错误，原始细节只进日志并关联 requestId
      const outbound = new UE({
        kind: error.kind,
        message: sanitizeUpstreamDetail(error.message, {
          maxLen: cfg.errorSanitize.maxLen,
          redactions: cfg.errorSanitize.redactions,
          replacement: ctx.model,
        }),
        vendorCode: error.vendorCode,
        status: error.status,
        retryAfterMs: error.retryAfterMs,
        suggestion: error.suggestion,
        rawBody: error.rawBody,
      });
      return { ok: false, error: outbound, durationMs, empty };
    },

    // eslint-disable-next-line max-lines-per-function -- API 动词：装配 → 首帧探测重试 → relay 交接的直线流程，拆分需传递十余项闭包装配态
    async chatStream(channel, request, opts): Promise<ChatStreamResult> {
      const start = Date.now();
      const assembled = assembleCtx(channel, request, opts);
      const bus = createStreamEventBus(emit, {
        providerName: opts?.providerName,
        model: opts?.model,
      });
      // 出站脱敏闭包：只作用于 C 端错误帧 message；事件面保真
      const sanitizeMessage = (message: string): string =>
        sanitizeUpstreamDetail(message, { ...cfg.errorSanitize, replacement: opts?.model });
      if ('error' in assembled) {
        return failEarlyStream(
          bus,
          assembled.error,
          assembled.error.kind,
          'unknown',
          sanitizeMessage,
        );
      }
      const { ctx } = assembled;
      // opts.model = 真实部署模型名 → 并入配置 redactions 后映射对外名 ctx.model（单趟替换去重）
      const outRedactions = cfg.errorSanitize.redactions.concat(
        opts?.model != null && opts.model !== ctx.model ? [opts.model] : [],
      );
      const sanitizeOut = (message: string): string =>
        sanitizeUpstreamDetail(message, {
          maxLen: cfg.errorSanitize.maxLen,
          redactions: outRedactions,
          replacement: ctx.model,
        });
      const key = channelKey(channel);
      if (!('error' in assembled)) {
        const adapter = resolveAdapter(channel);
        if (adapter instanceof UE) {
          return failEarlyStream(bus, adapter, ctx.requestId, key, sanitizeOut);
        }
        const finalBody = prepareBody({ channel, request, ctx, adapter, stream: true });
        const plan = adapter.planRequest(channel, {
          endpoint: ctx.endpoint,
          model: ctx.model,
          requestId: ctx.requestId,
          stream: true,
        });
        const url = joinUrl(channel.baseUrl, plan.path);

        const { outcome } = await withRetry(
          (attempt, signal) =>
            streamAttempt(
              {
                adapter,
                channel,
                url,
                headers: plan.headers,
                finalBody,
                ctx,
                cfg,
                guard,
                key,
                emit,
              },
              attempt,
              signal,
            ),
          retryOpts(ctx),
        );

        if (!outcome.ok) {
          if (outcome.empty) {
            bus.emitTerminal({
              type: 'empty_completion',
              requestId: ctx.requestId,
              channelKey: key,
              attempt: 1,
            });
          }
          return failEarlyStream(bus, outcome.error, ctx.requestId, key, sanitizeOut);
        }
        const handle = relayStream(outcome.value, {
          heartbeatIdleMs: cfg.stream.heartbeatIdleMs,
          inactivityTimeoutMs: cfg.stream.inactivityTimeoutMs,
          // 例外 2：响应侧 model 字段替换（默认关；开启时出站帧 model → 对外目录名）
          rewriteModel: cfg.responseModelRewrite ? ctx.model : undefined,
          // 合成的中段错误帧 message 同一出站脱敏（上游字节透传不变、事件面保真）
          sanitizeErrorDetail: sanitizeOut,
          signal: ctx.signal,
        });
        attachRelayReporting(handle, {
          bus,
          requestId: ctx.requestId,
          channelKey: key,
          startedAt: start,
        });
        // 合成 first_chunk（上游首字节已被 peek 锁定即发火）：TransformStream 是
        // 需求耦合——relay 侧 first_chunk 要等客户端读响应流才触发，而消费方
        // （网关 inference 的 decisive 锚）要等 first_chunk 才把响应交还路由，
        // 不合成则两侧互等成结构性死锁（e2e 抓出）。总线幂等：relay 侧同事件吞掉。
        bus.emitStream({ type: 'first_chunk', requestId: ctx.requestId, atMs: Date.now() });
        return { stream: handle.stream, events: bus.bind() };
      }
      return failEarlyStream(bus, new UE({ kind: 'invalid_config' }), 'unknown', 'unknown');
    },

    use(channel): ChannelClient {
      return {
        chat: (req, opts) => ai.chat(channel, req, opts),
        stream: (req, opts) => ai.chatStream(channel, req, opts),
        embed: (req, opts) => ai.chat(channel, req, { ...opts, endpoint: 'embeddings' }),
        probe: () => ai.probe(channel),
      };
    },

    async probe(channel): Promise<ProbeResult> {
      const cfgErr = assertChannel(channel);
      if (cfgErr) return { ok: false, durationMs: 0, error: invalidConfigError(cfgErr) };
      const adapter = resolveAdapter(channel);
      if (adapter instanceof UE) return { ok: false, durationMs: 0, error: adapter };
      const start = Date.now();
      let firstError: UpstreamError | undefined;
      for (const probe of adapter.probeRequests(channel)) {
        try {
          const res = await fetchUpstream(
            joinUrl(channel.baseUrl, probe.path),
            { method: 'GET', headers: probe.headers },
            { connectMs: cfg.timeout.connectMs, guard },
          );
          if (res.ok) return { ok: true, durationMs: Date.now() - start };
          const raw = await readBody(res);
          firstError ??= adapter.mapError(
            res.status,
            tryParseJson(raw) ?? raw,
            Object.fromEntries(res.headers),
          );
        } catch {
          // 下一探测
        }
      }
      return {
        ok: false,
        durationMs: Date.now() - start,
        error: firstError ?? new UE({ kind: 'network', message: 'probe failed' }),
      };
    },

    subscribe(observer) {
      listeners.push(observer);
      return () => {
        const i = listeners.indexOf(observer);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    tasks: createTaskOps({ adapters, resolveAdapter, cfg, guard }),
  };

  return ai;
}
