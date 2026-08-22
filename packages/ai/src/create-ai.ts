/**
 * createAi 装配壳（v2 平参数 API）：
 *   chat(channel, request, opts) / chatStream / use / subscribe / probe / tasks
 * 机制链：参数抹平 → 单次尝试体（withRetry 包裹）→ relay 透传 + 事件观察面。
 * 单渠道内重试；换渠道候选循环是 inference 的职责（§3.6 零运维状态）。
 */
import type {
  Ai,
  CallOptions,
  ChannelClient,
  ChannelDesc,
  ChatResult,
  ChatStreamResult,
  Endpoint,
  GenerationFileProbeResult,
  GenerationParsedResponse,
  GenerationTaskProbeResult,
  ProbeResult,
  UpstreamError,
} from './types';
import type { AiDefaults, AiDeps, AiDefaultsInput, AiOptions } from './config';
import { aiDefaultsSchema } from './config';
import type { ProtocolAdapter } from './adapters/protocol-adapter';
import type { AiEvent } from './events';
import { UpstreamError as UE } from './errors/kinds';
import { invalidConfigError, unsupportedProtocolError, taskOpsUnavailableError } from './errors/internal';
import { fetchUpstream, readBody, readRawBody } from './transport/http-client';
import { relayStream } from './transport/relay-stream';
import { peekFirstChunk, firstChunkStreamError } from './internal/stream';
import { withRetry } from './retry/with-retry';
import { resolveVendorProfile, mergeParamRules } from './registry/vendor-profiles';
import { channelKey, assertChannel, emitTo } from './pipeline/context';
import { joinUrl } from './join-url';
import { createStreamEventBus, failEarlyStream, attachRelayReporting } from './pipeline/stream-report';
import { OpenAICompatibleAdapter } from './adapters/openai-compatible';
import { AnthropicAdapter } from './adapters/anthropic';
import { GeminiAdapter } from './adapters/gemini';
import { AzureOpenAIAdapter } from './adapters/azure-openai';
import { AwsBedrockAdapter } from './adapters/aws-bedrock';
import { VertexAiAdapter } from './adapters/vertex-ai';
import { MiniMaxAdapter } from './adapters/minimax';
import { DashScopeAdapter } from './adapters/dashscope';

const noop = (): void => {};

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

interface CallCtx {
  requestId: string;
  model: string;
  endpoint: Endpoint;
  providerName?: string;
  paramRules?: CallOptions['paramRules'];
  maxRetries?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}

export function createAi(defaults?: AiDefaultsInput, deps: AiDeps = {}, options?: AiOptions): Ai {
  const cfg: AiDefaults = aiDefaultsSchema.parse(defaults ?? {});
  const log = deps.logger ?? { info: noop, warn: noop, error: noop };
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
    adapters.get(channel.protocol) ?? unsupportedProtocolError(channel.protocol, [...adapters.keys()]);

  const assembleCtx = (channel: ChannelDesc, request: unknown, opts?: CallOptions): { ctx: CallCtx } | { error: UpstreamError } => {
    const cfgErr = assertChannel(channel);
    if (cfgErr) return { error: invalidConfigError(cfgErr) };
    const rec = typeof request === 'object' && request !== null && !Array.isArray(request) ? (request as Record<string, unknown>) : null;
    const model = opts?.model ?? (typeof rec?.model === 'string' && rec.model ? rec.model : '');
    if (!model) return { error: invalidConfigError('model 缺失（request.model 或 opts.model 至少一项）') };
    if (opts?.endpoint && opts.endpoint !== 'chat' && opts.endpoint !== 'video' && opts.endpoint !== 'music') {
      const a = adapters.get(channel.protocol);
      if (a && !a.supportedEndpoints.includes(opts.endpoint)) {
        return { error: invalidConfigError(`protocol ${channel.protocol} 不支持 endpoint ${opts.endpoint}（支持: ${a.supportedEndpoints.join(',')}）`) };
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

  const prepareBody = (channel: ChannelDesc, request: unknown, ctx: CallCtx, adapter: ProtocolAdapter, stream: boolean) => {
    const profile = resolveVendorProfile(channel.vendor);
    const rules = mergeParamRules(profile?.params, ctx.paramRules);
    const { body, adjustments } = adapter.normalizeRequest(request, rules, ctx.endpoint);
    for (const a of adjustments) {
      log.info(`[ai] ${ctx.requestId} param_adjustment ${a.action} ${a.param}`, { from: a.from, to: a.to });
      emit({ type: 'param_adjustment', requestId: ctx.requestId, param: a.param, action: a.action, from: a.from, to: a.to } as never);
    }
    const rec = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    const wrappedForm = rec !== null && rec.upstreamForm instanceof FormData ? (rec.upstreamForm as FormData) : null;
    if (wrappedForm !== null && wrappedForm.has('model')) {
      wrappedForm.set('model', ctx.model); // 对外名 → 真实名（与 JSON 路径同语义）
    }
    const finalBody = wrappedForm ?? (rec ? adapter.finalizeRequestBody(rec, { endpoint: ctx.endpoint, model: ctx.model, stream }) : body);
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

  const taskOps = (channel: ChannelDesc) => {
    const a = resolveAdapter(channel);
    if (a instanceof UE) return a;
    return a.tasks ?? null;
  };

  const ai: Ai = {
    SUPPORTED_PROTOCOLS,

    async chat(channel, request, opts): Promise<ChatResult> {
      const start = Date.now();
      const assembled = assembleCtx(channel, request, opts);
      if ('error' in assembled) return { ok: false, error: assembled.error, durationMs: 0 };
      const { ctx } = assembled;
      const key = channelKey(channel);
      const adapter = resolveAdapter(channel);
      if (adapter instanceof UE) return { ok: false, error: adapter, durationMs: Date.now() - start };
      const finalBody = prepareBody(channel, request, ctx, adapter, false);
      const plan = adapter.planRequest(channel, { endpoint: ctx.endpoint, model: ctx.model, requestId: ctx.requestId, stream: false });
      const url = joinUrl(channel.baseUrl, plan.path);

      const { outcome, attempts } = await withRetry<{ usage?: import('./types').Usage; body?: unknown; rawBody?: Uint8Array; rawContentType?: string }>(
        async (attempt, signal) => {
          log.info(`[ai] ${ctx.requestId} attempt ${attempt} (${key})`);
          emit({ type: 'attempt_start', requestId: ctx.requestId, channelKey: key, attempt, atMs: Date.now() } as never);
          const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.totalMs)]);
          let headers = plan.headers;
          try {
            if (adapter.signRequest && typeof finalBody === 'string') {
              const signed = await adapter.signRequest({ url: new URL(url), body: finalBody, apiKey: channel.apiKey, at: new Date() });
              headers = { ...plan.headers, ...signed };
            }
            const res = await fetchUpstream(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...headers },
              body: finalBody instanceof FormData ? finalBody : typeof finalBody === 'string' ? finalBody : JSON.stringify(finalBody),
            }, { connectMs: cfg.timeout.connectMs, signal: totalSignal, guard });
            if (!res.ok) {
              const raw = await readBody(res, { signal: totalSignal });
              return { ok: false as const, error: adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers)) };
            }
            const ct = res.headers.get('content-type') ?? '';
            if (ct.includes('application/json')) {
              const raw = await readBody(res, { signal: totalSignal });
              const body = tryParseJson(raw);
              if (body === null) return { ok: false as const, error: new UE({ kind: 'invalid_response' }) };
              if (adapter.translateResponseBody) {
                const translated = adapter.translateResponseBody(body);
                return { ok: true as const, value: { usage: adapter.extractUsage(translated) ?? adapter.extractUsage(body) ?? undefined, body: translated } };
              }
              return { ok: true as const, value: { usage: adapter.extractUsage(body) ?? undefined, body } };
            }
            const rawBody = await readRawBody(res, { signal: totalSignal });
            return { ok: true as const, value: { rawBody, rawContentType: ct } };
          } catch (err) {
            if (err instanceof UE) return { ok: false as const, error: err };
            return { ok: false as const, error: err instanceof Error && err.message === 'aborted' ? new UE({ kind: 'canceled' }) : new UE({ kind: 'network', message: String(err) }) };
          }
        },
        retryOpts(ctx),
        (info) => log.warn(`[ai] ${ctx.requestId} retry attempt=${info.attempt} delay=${info.delayMs}`, { kind: info.error.kind }),
      );

      const durationMs = Date.now() - start;
      if (outcome.ok) {
        log.info(`[ai] ${ctx.requestId} success attempts=${attempts}`);
        emit({ type: 'success', requestId: ctx.requestId, channelKey: key, usage: outcome.value.usage, durationMs } as never);
        return { ok: true, usage: outcome.value.usage, body: outcome.value.body, rawBody: outcome.value.rawBody, rawContentType: outcome.value.rawContentType, durationMs };
      }
      const { error, empty } = outcome;
      log.error(`[ai] ${ctx.requestId} failed attempts=${attempts}`, { kind: error.kind, status: error.status });
      if (empty) emit({ type: 'empty_completion', requestId: ctx.requestId, channelKey: key, attempt: attempts } as never);
      else emit({ type: 'failed', requestId: ctx.requestId, channelKey: key, error } as never);
      return { ok: false, error, durationMs, empty };
    },

    async chatStream(channel, request, opts): Promise<ChatStreamResult> {
      const start = Date.now();
      const assembled = assembleCtx(channel, request, opts);
      const bus = createStreamEventBus(emit, { providerName: opts?.providerName, model: opts?.model });
      if ('error' in assembled) return failEarlyStream(bus, assembled.error, assembled.error.kind, 'unknown');
      const { ctx } = assembled;
      const key = channelKey(channel);
      if (!('error' in assembled)) {
        const adapter = resolveAdapter(channel);
        if (adapter instanceof UE) return failEarlyStream(bus, adapter, ctx.requestId, key);
        const finalBody = prepareBody(channel, request, ctx, adapter, true);
        const plan = adapter.planRequest(channel, { endpoint: ctx.endpoint, model: ctx.model, requestId: ctx.requestId, stream: true });
        const url = joinUrl(channel.baseUrl, plan.path);

        const { outcome } = await withRetry(
          async (attempt, signal) => {
            emit({ type: 'attempt_start', requestId: ctx.requestId, channelKey: key, attempt, atMs: Date.now() } as never);
            const totalSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.timeout.connectMs)]);
            try {
              const res = await fetchUpstream(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...plan.headers },
                body: JSON.stringify(finalBody),
              }, { connectMs: cfg.timeout.connectMs, signal: totalSignal, guard });
              if (!res.ok) {
                const raw = await readBody(res, { signal: totalSignal });
                return { ok: false as const, error: adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers)) };
              }
              if (!res.body) return { ok: false as const, error: new UE({ kind: 'invalid_response', message: 'no body' }) };
              const upstream = adapter.translateUpstreamStream ? adapter.translateUpstreamStream(res.body) : res.body;
              // 首帧探测（peek）：空流/首帧错误在此识别——重试仅限首字节前
              const peek = await peekFirstChunk(upstream, { timeoutMs: cfg.stream.firstByteTimeoutMs, signal: totalSignal });
              if (peek.done || !peek.rest) return { ok: false as const, error: new UE({ kind: 'empty_completion' }), empty: true };
              const fe = peek.first ? firstChunkStreamError(peek.first) : null;
              if (fe) return { ok: false as const, error: adapter.mapError(200, tryParseJson(new TextDecoder().decode(peek.first!)) ?? peek.first!) };
              return { ok: true as const, value: peek.rest };
            } catch (err) {
              if (err instanceof UE) return { ok: false as const, error: err };
              return { ok: false as const, error: new UE({ kind: 'network', message: String(err) }) };
            }
          },
          retryOpts(ctx),
        );

        if (!outcome.ok) {
          if (outcome.empty) bus.emitTerminal({ type: 'empty_completion', requestId: ctx.requestId, channelKey: key, attempt: 1 });
          return failEarlyStream(bus, outcome.error, ctx.requestId, key);
        }
        const handle = relayStream(outcome.value, {
          heartbeatIdleMs: cfg.stream.heartbeatIdleMs,
          inactivityTimeoutMs: cfg.stream.inactivityTimeoutMs,
          signal: ctx.signal,
        });
        attachRelayReporting(handle, { bus, requestId: ctx.requestId, channelKey: key, startedAt: start });
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
          const res = await fetchUpstream(joinUrl(channel.baseUrl, probe.path), { method: 'GET', headers: probe.headers }, { connectMs: cfg.timeout.connectMs, guard });
          if (res.ok) return { ok: true, durationMs: Date.now() - start };
          const raw = await readBody(res);
          firstError ??= adapter.mapError(res.status, tryParseJson(raw) ?? raw, Object.fromEntries(res.headers));
        } catch {
          // 下一探测
        }
      }
      return { ok: false, durationMs: Date.now() - start, error: firstError ?? new UE({ kind: 'network', message: 'probe failed' }) };
    },

    subscribe(observer) {
      listeners.push(observer);
      return () => {
        const i = listeners.indexOf(observer);
        if (i >= 0) listeners.splice(i, 1);
      };
    },

    tasks: {
      parse: (channel, kind, body): GenerationParsedResponse => {
        const ops = taskOps(channel);
        if (ops instanceof UE) return { kind: 'error', error: ops };
        if (ops === null) return { kind: 'error', error: taskOpsUnavailableError(channel.protocol) };
        return ops.parseResponse(kind, body);
      },
      query: async (channel, taskId): Promise<GenerationTaskProbeResult> => {
        const ops = taskOps(channel);
        if (ops instanceof UE) return { ok: false, error: ops };
        if (ops === null) return { ok: false, error: taskOpsUnavailableError(channel.protocol) };
        const plan = ops.planTaskQuery(channel, taskId);
        try {
          const res = await fetchUpstream(joinUrl(channel.baseUrl, plan.path), { method: 'GET', headers: plan.headers }, { connectMs: cfg.timeout.connectMs, guard });
          const raw = await readBody(res);
          const body = tryParseJson(raw) ?? raw;
          if (!res.ok) return { ok: false, error: (adapters.get(channel.protocol) as ProtocolAdapter).mapError(res.status, body) };
          return ops.parseTaskStatus(body);
        } catch (err) {
          return { ok: false, error: err instanceof UE ? err : new UE({ kind: 'network', message: String(err) }) };
        }
      },
      file: async (channel, fileId): Promise<GenerationFileProbeResult> => {
        const ops = taskOps(channel);
        if (ops instanceof UE) return { ok: false, error: ops };
        if (ops === null) return { ok: false, error: taskOpsUnavailableError(channel.protocol) };
        const plan = ops.planFileRetrieve(channel, fileId);
        try {
          const res = await fetchUpstream(joinUrl(channel.baseUrl, plan.path), { method: 'GET', headers: plan.headers }, { connectMs: cfg.timeout.connectMs, guard });
          const raw = await readBody(res);
          const body = tryParseJson(raw) ?? raw;
          if (!res.ok) return { ok: false, error: (adapters.get(channel.protocol) as ProtocolAdapter).mapError(res.status, body) };
          return ops.parseFileRetrieve(body);
        } catch (err) {
          return { ok: false, error: err instanceof UE ? err : new UE({ kind: 'network', message: String(err) }) };
        }
      },
    },
  };

  return ai;
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
