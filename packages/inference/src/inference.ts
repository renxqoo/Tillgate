import { randomUUID } from 'node:crypto';
import type { Ai, Endpoint } from '@tokenlens/ai';
import {
  inferenceDefaultsSchema,
  type InferenceDefaults,
  type InferenceDefaultsInput,
} from './config';
import { createMemoryGenerationTaskStore } from './adapters/task-memory';
import { createUpstreamAi } from './adapters/upstream-ai';
import { createChannelHealth, type ChannelHealth } from './health/channel-health';
import type { CatalogPort } from './ports/catalog';
import type { BillingPort } from './ports/billing';
import type { GenerationTaskStore, GenerationTaskView } from './ports/generation';
import type { HealthStore } from './ports/state';
import type { UpstreamPort } from './ports/upstream';
import { createChatAttempt, type ChatDelivered } from './application/chat';
import { createStreamAttempt, type StreamDelivered } from './application/stream';
import {
  createGenerationUseCase,
  type GenerationSubmitInput,
  type GenerationSubmitOutcome,
} from './application/generation';
import {
  runCandidateLoop,
  type AttemptContext,
  type AttemptOutcome,
  type ChannelAdmission,
  type ExecutionDeps,
  type PassthroughDelivered,
} from './application/failover';
import { prepareChatRequest } from './application/quote';
import type { RequestAuth } from './domain/model/types';

/**
 * createInference facade（装配消费面 = apps/gateway assembly；billing/control-plane
 * 建包前经 port 注入实现）。职责：缺省解析、健康订阅挂接（装配处只挂一次）、
 * 上游/任务适配器组装、预检 → authorize → 候选循环的编排。
 * 业务拒绝经 InferenceErrors 直抛（§11）；成功/透传结果判别联合返回。
 */
export interface ChatInput {
  requestId?: string;
  auth: RequestAuth;
  body: Record<string, unknown>;
  endpoint?: Endpoint;
  signal?: AbortSignal;
}

export interface InferenceEnv {
  /** 装配传入的 @tokenlens/ai 实例（inference 是其唯一运行时消费方，§3.6） */
  ai: Ai;
  catalog: CatalogPort;
  billing: BillingPort;
  /** 渠道健康跨请求状态存储（生产 redis 适配器；单副本/开发可用内存适配器） */
  store: HealthStore;
  /** 渠道凭据解密（runtime Cipher 装配注入；明文不出适配器调用栈） */
  decrypt: (enc: string) => string;
  /** 上游 port 替身（缺省内置 ai 适配器；测试注入 stub） */
  upstream?: UpstreamPort;
  /** 任务存储（缺省内存实现——单副本开发形态；生产装配 postgres 适配器） */
  tasks?: GenerationTaskStore;
  /** 渠道维限流钩子（gateway app 装配；未装配 = 放行） */
  admitChannel?: ChannelAdmission;
  defaults?: InferenceDefaultsInput;
  onError?: (error: unknown, context: string) => void;
}

export interface Inference {
  chat(input: ChatInput): Promise<ChatDelivered>;
  stream(input: ChatInput): Promise<StreamDelivered | PassthroughDelivered>;
  generation: {
    submit(input: GenerationSubmitInput): Promise<GenerationSubmitOutcome>;
    query(userId: number, taskId: string): Promise<GenerationTaskView>;
  };
  /** 装配诊断面（admit 检查；供运维/测试探测） */
  readonly health: ChannelHealth;
  /** 退订 ai 事件总线（进程关闭时调用） */
  close(): void;
}

export function createInference(env: InferenceEnv): Inference {
  const defaults: InferenceDefaults = inferenceDefaultsSchema.parse(env.defaults ?? {});
  const onError =
    env.onError ??
    ((error: unknown, context: string) => console.error(`[inference] ${context}:`, error));
  const health = createChannelHealth({
    store: env.store,
    config: { breaker: defaults.breaker, deadCredential: defaults.deadCredential },
    onFault: onError,
  });
  const detach = health.attach(env.ai);
  const upstream = env.upstream ?? createUpstreamAi({ ai: env.ai, decrypt: env.decrypt });
  const deps: ExecutionDeps = {
    catalog: env.catalog,
    billing: env.billing,
    upstream,
    health,
    ...(env.admitChannel != null ? { admitChannel: env.admitChannel } : {}),
    defaults,
    onError,
  };
  const chatAttempt = createChatAttempt(deps);
  const streamAttempt = createStreamAttempt(deps);
  const generation = createGenerationUseCase({
    ...deps,
    tasks: env.tasks ?? createMemoryGenerationTaskStore(),
  });

  /** 预检 → authorize → 候选循环（chat/stream 共用编排） */
  const run = async <T>(
    input: ChatInput,
    stream: boolean,
    attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>,
  ): Promise<T> => {
    const requestId = input.requestId ?? randomUUID();
    const requestStartedAt = Date.now();
    const prepared = await prepareChatRequest({
      catalog: env.catalog,
      defaults,
      requestId,
      auth: input.auth,
      body: input.body,
      ...(input.endpoint != null ? { endpoint: input.endpoint } : {}),
    });
    await env.billing.authorize({
      requestId,
      userId: input.auth.userId,
      apiKeyId: input.auth.apiKeyId,
      appId: input.auth.appId,
      stream,
      candidates: prepared.candidates,
      inputTokenUpperBound: prepared.inputUpperBound,
      maxOutputTokens: prepared.outputCap,
      authorizationTtlMs: defaults.authorization.ttlMs,
    });
    return await runCandidateLoop(
      deps,
      prepared,
      requestId,
      requestStartedAt,
      input.signal,
      attempt,
    );
  };

  return {
    chat: (input) => run(input, false, chatAttempt),
    stream: (input) => run(input, true, streamAttempt),
    generation,
    health,
    close: detach,
  };
}
