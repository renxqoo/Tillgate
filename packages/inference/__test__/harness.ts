/**
 * 测试装置（非测试文件，不匹配 include）：内存装配的最小 inference 环境。
 * 应用层用例注入 fake UpstreamPort；upstream-ai 适配器测试另配 fake Ai。
 */
import type {
  Ai,
  AiEvent,
  ErrorKind,
  GenerationTaskProbeResult,
  UpstreamError,
  Usage,
} from '@tillgate/ai';
import { UpstreamError as UpstreamErrorCtor } from '@tillgate/ai';
import { createInference, type Inference } from '../src/inference';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import type { BillingPort, BillingSignal } from '../src/ports/billing';
import type { CatalogPort } from '../src/ports/catalog';
import type {
  UpstreamCallRequest,
  UpstreamPort,
  UpstreamStreamEvent,
  UpstreamStreamResult,
  UpstreamTaskExecuteResult,
  UpstreamTaskSubmitResult,
} from '../src/ports/upstream';
import type {
  ChannelCandidate,
  ModelMappingSnapshot,
  RequestAuth,
} from '../src/domain/model/types';
import type { GenerationTaskKind } from '../src/domain/generation';

/** UpstreamError 快捷构造（机制位由派生表决定——测试不覆盖） */
export function upstreamError(
  kind: ErrorKind,
  opts: { status?: number; message?: string; retryAfterMs?: number } = {},
): UpstreamError {
  return new UpstreamErrorCtor({
    kind,
    ...(opts.message != null ? { message: opts.message } : {}),
    ...(opts.status != null ? { status: opts.status } : {}),
    ...(opts.retryAfterMs != null ? { retryAfterMs: opts.retryAfterMs } : {}),
  });
}

export function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    inputTokens: 100,
    cachedInputTokens: 0,
    outputTokens: 50,
    estimated: false,
    raw: null,
    ...overrides,
  };
}

export function mapping(overrides: Partial<ModelMappingSnapshot> = {}): ModelMappingSnapshot {
  return {
    mappingId: 11,
    externalModel: 'gpt-x',
    realModel: 'gpt-x-real',
    fallbackModels: [],
    inputPrice: '2',
    cacheInputPrice: '1',
    cacheWritePrice: null,
    outputPrice: '8',
    unitPrice: null,
    pricingUnit: 'token',
    unitUpperBound: 0,
    coefficient: '1',
    billingPolicyFingerprint: 'fp-1',
    ...overrides,
  };
}

export function channel(overrides: Partial<ChannelCandidate> = {}): ChannelCandidate {
  return {
    channelId: 7,
    channelName: 'ch-7',
    providerName: 'prov',
    protocol: 'openai-compatible',
    vendor: null,
    baseUrl: 'https://up.example.com/v1',
    apiKeyEnc: 'enc-7',
    upstreamModel: 'gpt-x-real',
    priority: 0,
    weight: 1,
    ...overrides,
  };
}

export const baseAuth: RequestAuth = {
  userId: 1,
  apiKeyId: 2,
  appId: null,
  allowedModels: null,
};

/** 可编程 ai 桩：只提供事件总线（upstream 用 port 替身，不经 ai） */
export function fakeAi() {
  const observers = new Set<(e: AiEvent) => void>();
  const ai = {
    subscribe: (fn: (e: AiEvent) => void) => {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  } as unknown as Ai;
  return {
    ai,
    emit: (e: AiEvent) => {
      for (const fn of Array.from(observers)) fn(e);
    },
  };
}

/** 未配置行为的缺省桩（模块级——占位实现不捕获闭包） */
const unconfiguredChat = async (): Promise<unknown> => ({
  ok: false,
  error: upstreamError('upstream_error'),
  durationMs: 0,
});
const unconfiguredStream = async (): Promise<UpstreamStreamResult> => {
  throw new Error('streamImpl not configured');
};
const unconfiguredSubmit = async (): Promise<UpstreamTaskSubmitResult> => ({
  ok: false,
  error: upstreamError('upstream_error'),
});
const unconfiguredQuery = async (): Promise<GenerationTaskProbeResult> => ({
  ok: false,
  error: upstreamError('upstream_error'),
});
const unconfiguredExecute = async (): Promise<UpstreamTaskExecuteResult> => ({
  ok: false,
  error: upstreamError('upstream_error'),
});
const noopAuthorize = async (): Promise<void> => {};
const allowReserve = async (): Promise<boolean> => true;

/** 可编程 UpstreamPort：行为按渠道注入，调用全记录 */
export function fakeUpstream() {
  const calls: { channel: ChannelCandidate; request: UpstreamCallRequest }[] = [];
  let chatImpl: (ch: ChannelCandidate, request: UpstreamCallRequest) => Promise<unknown> =
    unconfiguredChat;
  let streamImpl: (
    ch: ChannelCandidate,
    request: UpstreamCallRequest,
  ) => Promise<UpstreamStreamResult> = unconfiguredStream;
  let submitImpl: (
    ch: ChannelCandidate,
    kind: GenerationTaskKind,
    request: UpstreamCallRequest,
  ) => Promise<UpstreamTaskSubmitResult> = unconfiguredSubmit;
  const port: UpstreamPort = {
    chat: async (ch, request) => {
      calls.push({ channel: ch, request });
      return (await chatImpl(ch, request)) as never;
    },
    chatStream: async (ch, request) => {
      calls.push({ channel: ch, request });
      return await streamImpl(ch, request);
    },
    submitTask: async (ch, kind, request) => {
      calls.push({ channel: ch, request });
      return await submitImpl(ch, kind, request);
    },
    queryTask: async () => await unconfiguredQuery(),
    executeTask: async () => await unconfiguredExecute(),
  };
  return {
    port,
    calls,
    onChat: (fn: typeof chatImpl) => {
      chatImpl = fn;
    },
    onStream: (fn: typeof streamImpl) => {
      streamImpl = fn;
    },
    onSubmit: (fn: typeof submitImpl) => {
      submitImpl = fn;
    },
  };
}

/** 事件流结果装置：订阅前发出的事件缓冲并在首次订阅时重放（对齐 ai 终态重放语义） */
export function streamResultOf() {
  const listeners = new Set<(e: UpstreamStreamEvent) => void>();
  const buffer: UpstreamStreamEvent[] = [];
  let replayed = false;
  const result: UpstreamStreamResult = {
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"ok":1}\n\n'));
      },
    }),
    onEvent: (cb) => {
      listeners.add(cb);
      if (!replayed) {
        replayed = true;
        for (const e of buffer.splice(0)) cb(e);
      }
    },
  };
  const emit = (e: UpstreamStreamEvent) => {
    if (listeners.size === 0) {
      buffer.push(e);
      return;
    }
    for (const fn of Array.from(listeners)) fn(e);
  };
  return { result, emit };
}

/** 可编程 CatalogPort：映射表 + 渠道表 */
export function fakeCatalog(
  mappings: Record<string, ModelMappingSnapshot>,
  channelsByReal: Record<string, ChannelCandidate[]>,
): CatalogPort & { channelsByReal: Record<string, ChannelCandidate[]> } {
  return {
    findMapping: async (external, _pricing) => mappings[external] ?? null,
    resolveChannels: async (real) => channelsByReal[real] ?? [],
    channelsByReal,
  };
}

/** 可编程 BillingPort：信号全记录；authorize/reserve 行为可注入 */
export function fakeBilling() {
  const signals: BillingSignal[] = [];
  let authorizeImpl: () => Promise<void> = noopAuthorize;
  let reserveImpl: () => Promise<boolean> = allowReserve;
  const port: BillingPort = {
    authorize: async (input) => {
      authorizations.push(input);
      await authorizeImpl();
    },
    reserveChannel: async (input) => {
      reserves.push(input);
      return (await reserveImpl()) ? { allowed: true } : { allowed: false };
    },
    signal: async (input) => {
      signals.push(input);
    },
  };
  const authorizations: Parameters<BillingPort['authorize']>[0][] = [];
  const reserves: Parameters<BillingPort['reserveChannel']>[0][] = [];
  return {
    port,
    signals,
    authorizations,
    reserves,
    onAuthorize: (fn: () => Promise<void>) => {
      authorizeImpl = fn;
    },
    onReserve: (fn: () => Promise<boolean>) => {
      reserveImpl = fn;
    },
  };
}

/** 组装最小 inference（应用层用例测试入口） */
export function buildInference(env: {
  ai: Ai;
  catalog: CatalogPort;
  billing: BillingPort;
  upstream: UpstreamPort;
  defaults?: Parameters<typeof createInference>[0]['defaults'];
  admitChannel?: Parameters<typeof createInference>[0]['admitChannel'];
  admitModel?: Parameters<typeof createInference>[0]['admitModel'];
  trace?: Parameters<typeof createInference>[0]['trace'];
  policy?: Parameters<typeof createInference>[0]['policy'];
}): Inference {
  return createInference({
    ai: env.ai,
    catalog: env.catalog,
    billing: env.billing,
    store: createMemoryHealthStore(),
    decrypt: (enc) => `plain:${enc}`,
    upstream: env.upstream,
    ...(env.defaults != null ? { defaults: env.defaults } : {}),
    ...(env.admitChannel != null ? { admitChannel: env.admitChannel } : {}),
    ...(env.admitModel != null ? { admitModel: env.admitModel } : {}),
    ...(env.trace != null ? { trace: env.trace } : {}),
    ...(env.policy != null ? { policy: env.policy } : {}),
  });
}
