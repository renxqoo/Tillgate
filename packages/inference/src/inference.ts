import { randomUUID } from 'node:crypto';
import type { Ai, Endpoint } from '@tillgate/ai';
import {
  inferenceDefaultsSchema,
  type InferenceDefaults,
  type InferenceDefaultsInput,
} from './config';
import { createMemoryGenerationTaskStore } from './adapters/task-memory';
import { createUpstreamAi } from './adapters/upstream-ai';
import { createChannelHealth, type ChannelHealth } from './health/channel-health';
import { createRoutingMemory, type RoutingMemory } from './health/routing-memory';
import { defaultRoutingPolicy } from './routing/policy';
import { staticRoutingPolicy, type RoutingPolicyReader, type StickyStore } from './ports/routing';
import type { CatalogPort } from './ports/catalog';
import type { BillingPort } from './ports/billing';
import type {
  GenerationTaskAdminListInput,
  GenerationTaskAdminRow,
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
  type ModelAdmission,
  type ExecutionDeps,
} from './application/failover';
import type { PassthroughDelivered } from './application/dispatch';
import { prepareChatRequest, type PreparedRequest } from './application/quote';
import { noopTrace, type TracePort } from './ports/trace';
import type { RequestAuth } from './domain/model/types';

/**
 * createInference facade（装配消费面 = apps/gateway assembly；billing/control-plane
 * 经 port 注入实现）。职责：缺省解析、健康订阅挂接（装配处只挂一次）、
 * 上游/任务适配器组装、预检 → authorize → 候选循环的编排。
 * 业务拒绝经 InferenceErrors 直抛；成功/透传结果判别联合返回。
 * 阶段 span 经 trace port（装配绑 OTel；缺省 no-op 零开销）。
 */
export interface ChatInput {
  requestId?: string;
  auth: RequestAuth;
  body: Record<string, unknown>;
  endpoint?: Endpoint;
  /**
   * 客户端断连取消信号：HTTP 入口必须传 c.req.raw.signal（贯通到上游 fetch，
   * 终止分类 request_cancelled/server_draining 依赖它）。缺传 = 客户端断开后
   * 上游照跑、计费照走——路由层契约测试锁定各入口必传。
   */
  signal?: AbortSignal;
}

export interface InferenceEnv {
  /** 装配传入的 @tillgate/ai 实例（inference 是其唯一运行时消费方） */
  ai: Ai;
  catalog: CatalogPort;
  billing: BillingPort;
  /** 渠道健康跨请求状态存储（生产 redis 适配器；单副本/开发可用内存适配器） */
  store: HealthStore;
  /** 路由策略热源（gateway 装配 DB TTL reader；未装配 = 编译期缺省） */
  policy?: RoutingPolicyReader;
  /** cache 亲和粘滞键存储（gateway 装配 Redis；未装配 = 进程内实现） */
  stickyStore?: StickyStore;
  /** 渠道凭据解密（runtime Cipher 装配注入；明文不出适配器调用栈） */
  decrypt: (enc: string) => string;
  /** 上游 port 替身（缺省内置 ai 适配器；测试注入 stub） */
  upstream?: UpstreamPort;
  /** 任务存储（缺省内存实现——单副本开发形态；生产装配 postgres 适配器） */
  tasks?: GenerationTaskStore;
  /** 渠道维限流钩子（gateway app 装配；未装配 = 放行） */
  admitChannel?: ChannelAdmission;
  /** 模型维限流钩子（候选级 RPM/TPM；gateway app 装配；未装配 = 放行） */
  admitModel?: ModelAdmission;
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
    /** 管理面全量列表（任务存储读侧,不属主隔离） */
    adminList(input: GenerationTaskAdminListInput): Promise<{
      rows: Array<GenerationTaskAdminRow>;
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

/** 预检阶段（inference.prepare span：目录候选链 + 报价上限） */
async function prepareWithSpan(
  deps: ExecutionDeps,
  args: { requestId: string; requestStartedAt: number; input: ChatInput },
): Promise<PreparedRequest> {
  return await deps.trace.withSpan(
    'inference.prepare',
    {
      'request.id': args.requestId,
      'user.id': args.input.auth.userId,
      ...(typeof args.input.body.model === 'string' ? { 'ai.model': args.input.body.model } : {}),
    },
    async (span) => {
      const p = await prepareChatRequest({
        catalog: deps.catalog,
        defaults: deps.defaults,
        requestId: args.requestId,
        auth: args.input.auth,
        body: args.input.body,
        // 分时段选价锚点 = 准入时刻（fallback 重查复用同一值，不随查询时刻抖动）
        now: new Date(args.requestStartedAt),
        ...(args.input.endpoint != null ? { endpoint: args.input.endpoint } : {}),
      });
      span.setAttributes({ 'quote.candidates': p.candidates.length });
      return p;
    },
  );
}

/** authorize 阶段（billing.authorize span 内联包住） */
async function authorizeWithSpan(
  deps: ExecutionDeps,
  args: { input: ChatInput; requestId: string; stream: boolean; prepared: PreparedRequest },
): Promise<void> {
  await deps.trace.withSpan(
    'billing.authorize',
    {
      'request.id': args.requestId,
      'user.id': args.input.auth.userId,
      'billing.stream': args.stream,
    },
    () =>
      deps.billing.authorize({
        requestId: args.requestId,
        userId: args.input.auth.userId,
        apiKeyId: args.input.auth.apiKeyId,
        appId: args.input.auth.appId,
        stream: args.stream,
        candidates: args.prepared.candidates,
        inputTokenUpperBound: args.prepared.inputUpperBound,
        maxOutputTokens: args.prepared.outputCap,
        authorizationTtlMs: deps.defaults.authorization.ttlMs,
      }),
  );
}

/** 预检 → authorize → 候选循环（chat/stream 共用编排；前两段各包阶段 span） */
async function runInference<T>(
  deps: ExecutionDeps,
  args: {
    input: ChatInput;
    stream: boolean;
    requestId: string;
    requestStartedAt: number;
    attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>;
  },
): Promise<T> {
  const prepared = await prepareWithSpan(deps, {
    requestId: args.requestId,
    requestStartedAt: args.requestStartedAt,
    input: args.input,
  });
  await authorizeWithSpan(deps, {
    input: args.input,
    requestId: args.requestId,
    stream: args.stream,
    prepared,
  });
  return await runCandidateLoop(
    deps,
    prepared,
    args.requestId,
    args.requestStartedAt,
    args.input.signal,
    args.attempt,
  );
}

/** 装配执行依赖面（健康订阅挂一次 + 上游/追踪适配 + 缺省解析；chat 与 generation 共用） */
function buildExecutionDeps(
  env: InferenceEnv,
  defaults: InferenceDefaults,
): {
  deps: ExecutionDeps;
  health: ChannelHealth;
  memory: RoutingMemory;
  detach: () => void;
} {
  const onError =
    env.onError ??
    ((error: unknown, context: string) => console.error(`[inference] ${context}:`, error));
  const health = createChannelHealth({
    store: env.store,
    config: { breaker: defaults.breaker, deadCredential: defaults.deadCredential },
    onFault: onError,
  });
  const policy: RoutingPolicyReader = env.policy ?? staticRoutingPolicy(defaultRoutingPolicy());
  const memory = createRoutingMemory({ store: env.store, policy, onFault: onError });
  const detach = health.attach(env.ai);
  const upstream = env.upstream ?? createUpstreamAi({ ai: env.ai, decrypt: env.decrypt });
  const trace = env.trace ?? noopTrace;
  const deps: ExecutionDeps = {
    catalog: env.catalog,
    billing: env.billing,
    upstream,
    health,
    memory,
    policy,
    ...(env.stickyStore != null ? { sticky: env.stickyStore } : {}),
    ...(env.admitChannel != null ? { admitChannel: env.admitChannel } : {}),
    ...(env.admitModel != null ? { admitModel: env.admitModel } : {}),
    trace,
    defaults,
    onError,
  };
  return { deps, health, memory, detach };
}

export function createInference(env: InferenceEnv): Inference {
  const defaults: InferenceDefaults = inferenceDefaultsSchema.parse(env.defaults ?? {});
  const { deps, health, detach } = buildExecutionDeps(env, defaults);
  const chatAttempt = createChatAttempt(deps);
  const streamAttempt = createStreamAttempt(deps);
  const tasks = env.tasks ?? createMemoryGenerationTaskStore();
  const generation = createGenerationUseCase({
    ...deps,
    tasks,
  });

  /** 预检 → authorize → 候选循环（chat/stream 共用；requestId/起点时刻在此解析） */
  const run = <T>(
    input: ChatInput,
    stream: boolean,
    attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>,
  ): Promise<T> =>
    runInference(deps, {
      input,
      stream,
      requestId: input.requestId ?? randomUUID(),
      requestStartedAt: Date.now(),
      attempt,
    });

  return {
    chat: (input) => run(input, false, chatAttempt),
    stream: (input) => run(input, true, streamAttempt),
    generation: {
      submit: generation.submit,
      query: generation.query,
      // 管理读侧直通任务存储(admin-api 消费;单副本内存形态账本列恒空)
      adminList: (input) => tasks.adminList(input),
      settledAmounts: (taskIds) => tasks.settledAmounts(taskIds),
    },
    health,
    close: detach,
  };
}
