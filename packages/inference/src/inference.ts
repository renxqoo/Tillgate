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
import type {
  GenerationTaskAdminListInput,
  GenerationTaskStore,
  GenerationTaskView,
} from './ports/generation';
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
import { noopTrace, type TracePort } from './ports/trace';
import type { RequestAuth } from './domain/model/types';

/**
 * createInference facade（装配消费面 = apps/gateway assembly；billing/control-plane
 * 建包前经 port 注入实现）。职责：缺省解析、健康订阅挂接（装配处只挂一次）、
 * 上游/任务适配器组装、预检 → authorize → 候选循环的编排。
 * 业务拒绝经 InferenceErrors 直抛（§11）；成功/透传结果判别联合返回。
 * 阶段 span 经 trace port（装配绑 OTel；缺省 no-op 零开销——docs/observability.md §3）。
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
  /** 阶段 span 注入口（gateway 装配绑 OTel；未装配 = no-op 零开销） */
  trace?: TracePort;
  defaults?: InferenceDefaultsInput;
  onError?: (error: unknown, context: string) => void;
}

export interface Inference {
  chat(input: ChatInput): Promise<ChatDelivered>;
  stream(input: ChatInput): Promise<StreamDelivered | PassthroughDelivered>;
  generation: {
    submit(input: GenerationSubmitInput): Promise<GenerationSubmitOutcome>;
    query(userId: number, taskId: string): Promise<GenerationTaskView>;
    /** 管理面全量列表（admin-api P4;任务存储读侧,不属主隔离） */
    adminList(input: GenerationTaskAdminListInput): Promise<{
      rows: Array<import('./ports/generation.js').GenerationTaskAdminRow>;
      total: number;
    }>;
    /** 已结算任务实扣金额（页内批量;taskId → amount） */
    settledAmounts(taskIds: readonly string[]): Promise<Map<string, string>>;
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
  const trace = env.trace ?? noopTrace;
  const deps: ExecutionDeps = {
    catalog: env.catalog,
    billing: env.billing,
    upstream,
    health,
    ...(env.admitChannel != null ? { admitChannel: env.admitChannel } : {}),
    trace,
    defaults,
    onError,
  };
  const chatAttempt = createChatAttempt(deps);
  const streamAttempt = createStreamAttempt(deps);
  const tasks = env.tasks ?? createMemoryGenerationTaskStore();
  const generation = createGenerationUseCase({
    ...deps,
    tasks,
  });

  /** 预检 → authorize → 候选循环（chat/stream 共用编排；前两段各包阶段 span） */
  const run = async <T>(
    input: ChatInput,
    stream: boolean,
    attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>,
  ): Promise<T> => {
    const requestId = input.requestId ?? randomUUID();
    const requestStartedAt = Date.now();
    const prepared = await trace.withSpan(
      'inference.prepare',
      {
        'request.id': requestId,
        'user.id': input.auth.userId,
        ...(typeof input.body.model === 'string' ? { 'ai.model': input.body.model } : {}),
      },
      async (span) => {
        const p = await prepareChatRequest({
          catalog: env.catalog,
          defaults,
          requestId,
          auth: input.auth,
          body: input.body,
          // 分时段选价锚点 = 准入时刻（fallback 重查复用同一值，不随查询时刻抖动）
          now: new Date(requestStartedAt),
          ...(input.endpoint != null ? { endpoint: input.endpoint } : {}),
        });
        span.setAttributes({ 'quote.candidates': p.candidates.length });
        return p;
      },
    );
    await trace.withSpan(
      'billing.authorize',
      {
        'request.id': requestId,
        'user.id': input.auth.userId,
        'billing.stream': stream,
      },
      () =>
        env.billing.authorize({
          requestId,
          userId: input.auth.userId,
          apiKeyId: input.auth.apiKeyId,
          appId: input.auth.appId,
          stream,
          candidates: prepared.candidates,
          inputTokenUpperBound: prepared.inputUpperBound,
          maxOutputTokens: prepared.outputCap,
          authorizationTtlMs: defaults.authorization.ttlMs,
        }),
    );
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
    generation: {
      submit: generation.submit,
      query: generation.query,
      // 管理读侧直通任务存储(admin-api P4 消费;单副本内存形态账本列恒空)
      adminList: (input) => tasks.adminList(input),
      settledAmounts: (taskIds) => tasks.settledAmounts(taskIds),
    },
    health,
    close: detach,
  };
}
