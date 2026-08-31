import type { InferenceDefaults } from '../config';
import { InferenceErrors } from '../domain/errors';
import type { ChannelCandidate, QuoteCandidate } from '../domain/model/types';
import { isChannelExhausted, isRequestScopedRejection } from '../domain/routing/switchable';
import type { ChannelHealth } from '../health/channel-health';
import type { RoutingMemory } from '../health/routing-memory';
import type { BillingPort } from '../ports/billing';
import type { CatalogPort } from '../ports/catalog';
import type { RoutingPolicyReader, StickyStore } from '../ports/routing';
import type { TracePort } from '../ports/trace';
import type { UpstreamPort } from '../ports/upstream';
import type { RoutingPolicy } from '../routing/policy';
import { gateChannel } from '../routing/gates';
import { pickPrimaryChannel, rankChannels } from '../routing/ranker';
import { recordSticky, resolveStickyContext } from '../routing/sticky';
import type { PreparedRequest } from './quote';

/**
 * 候选 × 渠道双层循环（组件化形态）：
 *
 *   for 候选（主模型 + fallback 链）→ 模型维准入（死记忆/RPM/TPM）：
 *     渠道排序（routing/ranker：priority 分层 + scorer 管线加权随机，sticky 亲和）
 *     → 渠道门（routing/gates：限流→健康→条件惩罚→预算）
 *     → 渠道敞口预留 → upstream_started → 单次尝试（重试预算 = policy.retry）
 *
 * 全败收尾：有界等待（policy.wait——全部渠道限流冷却且最早恢复 <maxWaitMs 时
 * 网关内等待后重试一轮，消化上游短暂限流）→ request_failed 三路释放 → 渠道面
 * 竭尽/上游故障终结错误。尝试总数无上限（预算与限流止步）。
 */

/** 渠道维准入钩子（gateway app 装配限流；未装配 = 单副本开发形态全放行）。 */
export type ChannelAdmission = (
  channel: ChannelCandidate,
  estimatedTokens: number,
  requestId: string,
) => Promise<boolean>;

/** 模型维准入钩子（候选级——realModel 维 RPM/TPM；false = 换候选走 fallback 链） */
export type ModelAdmission = (
  candidate: { realModel: string; rpmLimit?: number | null; tpmLimit?: number | null },
  estimatedTokens: number,
  requestId: string,
) => Promise<boolean>;

export interface ExecutionDeps {
  catalog: CatalogPort;
  billing: BillingPort;
  upstream: UpstreamPort;
  health: ChannelHealth;
  memory: RoutingMemory;
  /** 路由策略（热配置——排序/重试/惩罚/等待全部参数面；缺省 = 编译期缺省） */
  policy: RoutingPolicyReader;
  /** cache 亲和粘滞键存储（未装配 = 无亲和） */
  sticky?: StickyStore;
  admitChannel?: ChannelAdmission;
  admitModel?: ModelAdmission;
  trace: TracePort;
  defaults: InferenceDefaults;
  onError?: (error: unknown, context: string) => void;
}

/** 租约属主标识（单一真相——upstream_started / lease_renewed 共用；billing 侧按 owner 认领） */
export const LEASE_OWNER = 'inference';

export interface AttemptContext {
  prepared: PreparedRequest;
  requestId: string;
  /** 请求进入时刻（clientTtft 锚点——含授权/路由与换渠等待） */
  requestStartedAt: number;
  signal?: AbortSignal;
  candidate: QuoteCandidate;
  channel: ChannelCandidate;
  /** 当前候选内第几次渠道尝试（span 属性 channel.attempt） */
  channelAttempt: number;
  /** cache 亲和指纹（结算成功后粘滞记录的键——runPass 计算，尝试链透传） */
  stickyKey: string;
}

export type AttemptOutcome<T> =
  | { kind: 'switch_channel'; code?: string }
  | { kind: 'next_candidate'; code?: string }
  | { kind: 'respond'; value: T };

/** 一轮完整候选×渠道尝试的产物（终局/全败事实——有界等待的输入） */
interface PassOutcome<T> {
  value?: T;
  lastCode: string | undefined;
  channels: ChannelCandidate[];
  /** 本轮「有健康证据的耗尽候选」（realModel）——死记忆由请求级收口记账，
   * 每候选每请求恰一次（等待重试轮不重复记：契约见 model-dead.ts） */
  failedRealModels: ReadonlySet<string>;
}

/** 一轮循环的入参打包（attempt 动词与请求五要素 + 策略快照各有其位） */
interface PassArgs<T> {
  deps: ExecutionDeps;
  prepared: PreparedRequest;
  requestId: string;
  requestStartedAt: number;
  signal: AbortSignal | undefined;
  attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>;
  /** 入口快照的策略贯穿整轮（等待重试轮重取——热更新边界即轮边界） */
  policy: ReturnType<RoutingPolicyReader['latest']>;
  /** 上游尝试计数观察者（观测面：request_logs.attempts/channels——末参为评估序渠道轨迹） */
  onAttempts?: (total: number, channels: string[]) => void;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 首次成功预留后 upstream_started（租约开始；每请求只发一次） */
async function signalUpstreamStarted(deps: ExecutionDeps, requestId: string): Promise<void> {
  await deps.billing.signal({
    type: 'upstream_started',
    requestId,
    leaseOwner: LEASE_OWNER,
    leaseMs: deps.defaults.authorization.ttlMs,
  });
}

/** cache 亲和粘滞记录（偏好面——fire-and-forget，无需上游成功证据） */
export function recordStickyAffinity(
  deps: ExecutionDeps,
  ctx: {
    channel: { channelId: number };
    stickyKey: string;
  },
): void {
  void recordSticky({
    store: deps.sticky,
    key: ctx.stickyKey,
    channelId: ctx.channel.channelId,
    policy: deps.policy.latest(),
  }).catch((error) => deps.onError?.(error, `sticky record channel=${ctx.channel.channelId}`));
}

/**
 * 结算成功记账（chat/stream 收口共用）：死凭据自愈 + 候选死记忆清零 + sticky 粘滞。
 * 契约：调用点必须已有「上游调用成功且结算落账」的证据——死凭据/死记忆的清零
 * 以此为前提；无上游调用的登记态（task_execute）只记 sticky（recordStickyAffinity），
 * 不得触发自愈（坏 Key/死模型检测不能被无证据流量重置）。
 */
export function recordSettleSuccess(
  deps: ExecutionDeps,
  ctx: {
    channel: { channelId: number };
    candidate: { realModel: string };
    stickyKey: string;
  },
): void {
  deps.health.recordChannelSuccess(ctx.channel.channelId);
  deps.memory.recordModelSuccess(ctx.candidate.realModel);
  recordStickyAffinity(deps, ctx);
}

// eslint-disable-next-line max-params, max-lines-per-function -- 编排入参六要素(依赖/预检/请求标识/起点时刻/取消信号/尝试动词)各有其位,导出 API 改 options 放大 diff
export async function runCandidateLoop<T>(
  deps: ExecutionDeps,
  prepared: PreparedRequest,
  requestId: string,
  requestStartedAt: number,
  signal: AbortSignal | undefined,
  attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>,
  onAttempts?: (total: number, channels: string[]) => void,
): Promise<T> {
  const args: PassArgs<T> = {
    deps,
    prepared,
    requestId,
    requestStartedAt,
    signal,
    attempt,
    policy: deps.policy.latest(),
    onAttempts,
  };
  const first = await runPass(args);
  if (args.policy.enabled) recordDeadModelFailures(deps, first.failedRealModels);
  if (first.value !== undefined) return first.value;
  // 有界等待（B3 修复）：全败且原因是限流冷却 → 最早恢复在窗口内则等待重试一轮
  const waited = await maybeWaitAndRetry(args, first);
  // 死记忆请求级收口（差集）：等待轮与首轮撞同一耗尽候选只记一次——
  // 轮内重复计数会把「一个请求 + 一次重试」放大成 2 次失败，两轮全 429 即判死
  if (args.policy.enabled) {
    recordDeadModelFailures(
      deps,
      new Set([...waited.failedRealModels].filter((m) => !first.failedRealModels.has(m))),
    );
  }
  if (waited.value !== undefined) return waited.value;
  // 终局事实取等待轮的 lastCode（重试后失败原因可能已变——503/502 归因不失真）
  return releaseAndFail(deps, { prepared, requestId, lastCode: waited.lastCode });
}

/** 候选死记忆批量记账（fire-and-forget——尽力记忆，失败不阻断响应路径） */
function recordDeadModelFailures(deps: ExecutionDeps, realModels: ReadonlySet<string>): void {
  for (const realModel of realModels) deps.memory.recordModelFailure(realModel);
}

/**
 * 候选准入与渠道序预解析（每候选一次）：死记忆 / 模型维限流钩子拒绝 → skip 事实；
 * 通过 → scorer 管线排序渠道 + 条件惩罚门快照（存在未惩罚渠道才启用惩罚跳过、
 * 全冷却放行——惩罚是排序信号不是禁入；conditionalBypass=false 为冷却即拒的
 * 保守语义）。
 */
async function planCandidatePass(
  deps: ExecutionDeps,
  args: {
    requestId: string;
    candidate: QuoteCandidate;
    policy: ReturnType<RoutingPolicyReader['latest']>;
    stickyChannelId: number | null;
    estimatedTokens: number;
  },
): Promise<
  | { skip: { reason: 'dead_model' | 'rate_limited'; code: string } }
  | { channels: ChannelCandidate[]; penaltyEnforced: boolean }
> {
  // 单渠道直连：死记忆是路由信号（换渠事实的聚合），直连模式不换渠故不咨询——
  // 唯一候选的死记忆跳过只会把「渠道可用」误报成 503（用户裁决 D1/D3）
  if (args.policy.enabled && (await deps.memory.deadModel(args.candidate.realModel))) {
    return { skip: { reason: 'dead_model', code: 'no_available_channel' } };
  }
  if (
    deps.admitModel != null &&
    !(await deps.admitModel(args.candidate, args.estimatedTokens, args.requestId))
  ) {
    return { skip: { reason: 'rate_limited', code: 'rate_limit_exceeded' } };
  }
  const channels = await resolveChannelOrder(deps, {
    requestId: args.requestId,
    candidate: args.candidate,
    policy: args.policy,
    stickyChannelId: args.stickyChannelId,
  });
  // 单渠道直连不启用惩罚门（路由信号停用——用户裁决 D3）
  if (!args.policy.enabled) return { channels, penaltyEnforced: false };
  const penalized = await Promise.all(channels.map((ch) => deps.memory.penalized(ch.channelId)));
  const penaltyEnforced = args.policy.penalty.conditionalBypass ? penalized.some((p) => !p) : true;
  return { channels, penaltyEnforced };
}

/** 单渠道直连：候选链截断为主模型（不换候选模型——用户裁决 D1） */
function candidatesOf(
  candidates: readonly QuoteCandidate[],
  policy: RoutingPolicy,
): readonly QuoteCandidate[] {
  return policy.enabled ? candidates : candidates.slice(0, 1);
}

/** 尝试轨迹上报（attempt 后与全 gate 拒收尾共用——快照数组防调用方突变） */
function reportAttemptTrace(
  on: PassArgs<unknown>['onAttempts'],
  total: number,
  trace: readonly string[],
): void {
  on?.(total, [...trace]);
}

/** 一轮候选×渠道循环（全败返回事实供有界等待决策） */
// eslint-disable-next-line max-lines-per-function, max-statements -- 候选×渠道双层编排平铺（准入/排序已拆 planCandidatePass），再拆需传递可变循环状态
async function runPass<T>(args: PassArgs<T>): Promise<PassOutcome<T>> {
  const { deps, prepared, requestId, requestStartedAt, signal, attempt, policy } = args;
  let lastCode: string | undefined;
  let leaseStarted = false;
  const estimatedTokens = prepared.inputUpperBound + prepared.outputCap;
  const { key: stickyKey, channelId: stickyChannelId } = await resolveStickyContext(
    deps.sticky,
    {
      auth: prepared.auth,
      body: prepared.body,
      externalModel: prepared.externalModel,
      endpoint: prepared.endpoint,
    },
    policy.scorers.cacheAffinity.prefixChars,
  );
  const allChannels: ChannelCandidate[] = [];
  const failedRealModels = new Set<string>();
  let attemptTotal = 0;
  // 评估序渠道轨迹（含被门拒绝的渠道——失败请求的换渠排障事实，随 attempts 上报）
  const channelTrace: string[] = [];

  for (const candidate of candidatesOf(prepared.candidates, policy)) {
    const plan = await planCandidatePass(deps, {
      requestId,
      candidate,
      policy,
      stickyChannelId,
      estimatedTokens,
    });
    if ('skip' in plan) {
      // 死记忆跳过不覆盖已有失败码（弱证据）；限流拒绝归一 rate_limit_exceeded
      lastCode = plan.skip.reason === 'dead_model' ? (lastCode ?? plan.skip.code) : plan.skip.code;
      await skipModel({
        deps,
        requestId,
        realModel: candidate.realModel,
        reason: plan.skip.reason,
      });
      continue;
    }
    const { channels, penaltyEnforced } = plan;
    allChannels.push(...channels);
    let channelAttempt = 0;
    // 候选内是否出现反映渠道/模型真实健康的失败——请求维门拒绝（预算/准入
    // 预占按本请求估算）不判死模型，只有健康证据（上游失败/熔断/死凭据/惩罚）
    // 才计入死记忆（isRequestScopedRejection 词表单一真相）
    let healthEvidence = false;
    // 请求维门拒绝存在时判死（临时状态会连坐其恢复后的流量——2026-08-31 修复）
    let requestScopedRejection = false;
    for (const channel of channels) {
      channelAttempt += 1;
      channelTrace.push(channel.channelName);
      const gateCode = await gateChannel({
        env: deps,
        args: {
          requestId,
          prepared,
          candidate,
          channel,
          channelAttempt,
          estimatedTokens,
        },
        penaltyEnforced,
        // 现场复核仅 bypass 语义下生效——conditionalBypass=false 是保守硬拒（冷却即拒）
        ...(policy.penalty.conditionalBypass
          ? { penaltyFallback: (currentId: number) => othersAllCooling(deps, channels, currentId) }
          : {}),
      });
      if (gateCode != null) {
        lastCode = gateCode;
        if (isRequestScopedRejection(gateCode)) requestScopedRejection = true;
        else healthEvidence = true;
        continue;
      }
      if (!leaseStarted) {
        await signalUpstreamStarted(deps, requestId);
        leaseStarted = true;
      }
      // 尝试上下文装配（取消信号条件展开）
      const outcome = await attempt({
        prepared,
        requestId,
        requestStartedAt,
        ...(signal != null ? { signal } : {}),
        candidate,
        channel,
        channelAttempt,
        stickyKey,
      });
      attemptTotal += 1;
      reportAttemptTrace(args.onAttempts, attemptTotal, channelTrace);
      if (outcome.kind !== 'respond') {
        lastCode = outcome.code;
        healthEvidence = accumulateHealthEvidence(healthEvidence, outcome);
        if (outcome.kind === 'switch_channel') continue;
        break; // next_candidate：候选耗尽（含 canceled 等非 respond 终态的兜底臂）
      }
      return { value: outcome.value, lastCode, channels: allChannels, failedRealModels };
    }
    // 记账上移请求级（runCandidateLoop 差集收口）——等待重试轮重跑本函数时
    // 不再重复计数（契约「一次请求最多记一次」，model-dead.ts）。
    // 判死 = 全部渠道以健康证据耗尽：请求维门拒绝（预算/软限流）是临时状态，
    // 混入证据会把「从未真死」的渠道连坐进死窗口
    if (healthEvidence && !requestScopedRejection) failedRealModels.add(candidate.realModel);
  }
  // 全渠道被门拒绝（零上游尝试）也要带出轨迹——预算闸门竭尽场景的排障事实
  reportAttemptTrace(args.onAttempts, attemptTotal, channelTrace);
  return { lastCode, channels: allChannels, failedRealModels };
}

/** 失败尝试的健康证据累积：invalid_config（能力门/配置缺字段）零上游调用、
 * canceled（客户端断连）/server_draining（网关停机中止）不是渠道的错——
 * 都不得记死模型（会连坐该模型的正常 chat 流量与同候选其余渠道） */
const NON_HEALTH_EVIDENCE_CODES: ReadonlySet<string> = new Set([
  'invalid_config',
  'canceled',
  'server_draining',
]);
function accumulateHealthEvidence(
  current: boolean,
  outcome: { kind: string; code?: string },
): boolean {
  if (outcome.kind === 'respond') return current;
  return outcome.code != null && !NON_HEALTH_EVIDENCE_CODES.has(outcome.code);
}

/** 现场复核：除当前渠道外是否全部处于惩罚冷却（单渠道 = 无其它选择 → true） */
async function othersAllCooling(
  deps: ExecutionDeps,
  channels: readonly ChannelCandidate[],
  currentId: number,
): Promise<boolean> {
  const rest = channels.filter((ch) => ch.channelId !== currentId);
  if (rest.length === 0) return true;
  const states = await Promise.all(rest.map((ch) => deps.memory.penalized(ch.channelId)));
  return states.every((p) => p);
}

/** 候选跳过事实进 trace 不进响应 */
async function skipModel(input: {
  deps: ExecutionDeps;
  requestId: string;
  realModel: string;
  reason: string;
}): Promise<void> {
  const { deps, requestId, realModel, reason } = input;
  await deps.trace.withSpan(
    'model.skip',
    { 'request.id': requestId, 'ai.model': realModel, 'skip.reason': reason },
    async () => {},
  );
}

/** 路由解析：候选渠道 → scorer 管线排序（渠道数进 trace；sticky 亲和在此生效） */
async function resolveChannelOrder(
  deps: ExecutionDeps,
  args: {
    requestId: string;
    candidate: QuoteCandidate;
    policy: ReturnType<RoutingPolicyReader['latest']>;
    stickyChannelId: number | null;
  },
): Promise<ChannelCandidate[]> {
  return deps.trace.withSpan(
    'routing.resolve',
    { 'request.id': args.requestId, 'ai.model': args.candidate.realModel },
    async (span) => {
      const resolved = await deps.catalog.resolveChannels(args.candidate.realModel);
      // 单渠道直连：确定性首选（policy.enabled=false——用户裁决 D1），不随机不评分
      let list: ChannelCandidate[];
      if (args.policy.enabled) {
        list = rankChannels({
          channels: resolved,
          policy: args.policy,
          ctx: { stickyChannelId: args.stickyChannelId },
        });
      } else {
        const primary = pickPrimaryChannel(resolved);
        list = primary != null ? [primary] : [];
      }
      span.setAttributes({ 'routing.channels': list.length });
      return list;
    },
  );
}

/**
 * 有界等待 + 单轮重试：全败且限流类 → 最早惩罚恢复 ≤ maxWaitMs 时等待后重跑一轮。
 * 等待轮是整轮重跑：同渠道会再次 reserveChannel / upstream_started——幂等依赖
 * 已核实：casUpstreamStarted 以 status ∈ {authorized, in_flight} 为条件、二次
 * 仅刷新租约（packages/billing/src/adapters/postgres/billing-store.ts）；reserveChannel
 * 同渠道同额度走 covered/topup 决策不重复预扣
 * （packages/billing/src/application/billing/reserve-channel.ts）。改动 billing
 * 上述语义时必须复核此处。
 */
async function maybeWaitAndRetry<T>(
  args: PassArgs<T>,
  failed: PassOutcome<T>,
): Promise<PassOutcome<T>> {
  const { deps, signal } = args;
  const policy = deps.policy.latest();
  const waitable =
    policy.enabled &&
    policy.wait.enabled &&
    (failed.lastCode === 'rate_limited' || failed.lastCode === 'rate_limit_exceeded');
  if (!waitable || failed.channels.length === 0) return failed; // 未等待：原事实直通终局
  const recoveries = await Promise.all(
    failed.channels.map((ch) => deps.memory.penaltyRemainingMs(ch.channelId)),
  );
  const earliest = Math.min(...recoveries);
  if (earliest <= 0 || earliest > policy.wait.maxWaitMs) return failed;
  if (signal?.aborted) return failed; // 客户端已断开：不再占用等待窗
  await deps.trace.withSpan(
    'routing.bounded_wait',
    { 'request.id': args.requestId, 'routing.wait_ms': earliest },
    async () => {},
  );
  await sleep(earliest + 30);
  if (signal?.aborted) return failed;
  return await runPass(args);
}

/** 全败收尾：request_failed 三路释放 + 渠道面竭尽/上游故障终结 */
async function releaseAndFail(
  deps: ExecutionDeps,
  args: { prepared: PreparedRequest; requestId: string; lastCode: string | undefined },
): Promise<never> {
  const { prepared, requestId, lastCode } = args;
  const exhausted = isChannelExhausted(lastCode);
  // 出站信封按竭尽/故障二分（503/502），但 request_failed 信号 reason 保留真实
  // 终因（如 quota_exhausted/rate_limited）——billing failure_code 是排障粒度，
  // 归一成 no_available_channel 会丢失「为什么没有渠道」的可观测事实
  const reason = (lastCode ?? 'no_available_channel').slice(0, 64);
  const error = InferenceErrors.business(exhausted ? 'no_available_channel' : 'upstream_failed', {
    model: prepared.externalModel,
    ...(lastCode != null ? { upstream_code: lastCode } : {}),
  });
  await deps.trace.withSpan(
    'billing.release_and_fail',
    {
      'request.id': requestId,
      'user.id': prepared.auth.userId,
      'error.code': lastCode ?? 'no_available_channel',
    },
    async (span) => {
      span.setStatus({ code: 'error', message: lastCode ?? 'no_available_channel' });
      await deps.billing.signal({ type: 'request_failed', requestId, reason });
    },
  );
  throw error;
}
