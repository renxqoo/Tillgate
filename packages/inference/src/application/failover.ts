import type { UpstreamError } from '@tillgate/ai';
import type { InferenceDefaults } from '../config';
import { InferenceErrors } from '../domain/errors';
import type { ChannelCandidate, QuoteCandidate } from '../domain/model/types';
import { weightedOrderByPriority } from '../domain/routing/schedule';
import { isChannelExhausted, routeFailure } from '../domain/routing/switchable';
import { channelHealthKey, type ChannelHealth } from '../health/channel-health';
import type { BillingPort } from '../ports/billing';
import type { CatalogPort } from '../ports/catalog';
import type { TracePort } from '../ports/trace';
import type { UpstreamPort } from '../ports/upstream';
import type { PreparedRequest } from './quote';

/**
 * 候选 × 渠道双层循环（v1 run-chat 循环体迁移；限流闸剥离，健康检查移入，阶段 span
 * 经 TracePort 回填——v1 withAsyncSpan 面等价，命名见 docs/observability.md §3）：
 *
 *   for 候选（主模型 + fallback 链）→ 渠道加权调度序：
 *     渠道维限流钩子（app 装配，缺省放行）→ 健康放行（C4：v1 ai 内 admission 等价）
 *     → 渠道敞口预留（reserveChannel）→ 首次成功预留后 upstream_started（租约开始）
 *     → 单次尝试（结局编码 AttemptOutcome，控制流由本循环翻译：
 *        switch_channel → continue；next_candidate → break；respond → 返回）
 *
 * 全败收尾：request_failed 三路释放信号 + 渠道面竭尽（no_available_channel）/
 * 上游故障（upstream_failed）终结错误。尝试总数无上限（v1 B6 保留——预算与限流止步）。
 */

/** 渠道维准入钩子（gateway app 装配限流；未装配 = 单副本开发形态全放行） */
export type ChannelAdmission = (
  channel: ChannelCandidate,
  estimatedTokens: number,
) => Promise<boolean>;

export interface ExecutionDeps {
  catalog: CatalogPort;
  billing: BillingPort;
  upstream: UpstreamPort;
  health: ChannelHealth;
  admitChannel?: ChannelAdmission;
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
}

export type AttemptOutcome<T> =
  | { kind: 'switch_channel'; code?: string }
  | { kind: 'next_candidate'; code?: string }
  | { kind: 'respond'; value: T };

/** 上游 4xx 透传终局（OpenAI 兼容语义：客户端问题原码返回——不吞成 502、不空耗 fallback） */
export interface PassthroughDelivered {
  ok: true;
  passthrough: true;
  status: number;
  code: string;
  message?: string;
}

export async function runCandidateLoop<T>(
  deps: ExecutionDeps,
  prepared: PreparedRequest,
  requestId: string,
  requestStartedAt: number,
  signal: AbortSignal | undefined,
  attempt: (ctx: AttemptContext) => Promise<AttemptOutcome<T>>,
): Promise<T> {
  let lastCode: string | undefined;
  let leaseStarted = false;
  const estimatedTokens = prepared.inputUpperBound + prepared.outputCap;
  /** 渠道跳过事实（v1 channel.skip span 等价：跳过原因进 trace 不进响应） */
  const skipChannel = (channel: ChannelCandidate, index: number, reason: string): Promise<void> =>
    deps.trace.withSpan(
      'channel.skip',
      {
        'request.id': requestId,
        'channel.key': channel.channelName,
        'channel.attempt': index,
        'skip.reason': reason,
      },
      async () => undefined,
    );

  for (const candidate of prepared.candidates) {
    const channels = await deps.trace.withSpan(
      'routing.resolve',
      { 'request.id': requestId, 'ai.model': candidate.realModel },
      async (span) => {
        const list = weightedOrderByPriority(
          await deps.catalog.resolveChannels(candidate.realModel),
        );
        span.setAttributes({ 'routing.channels': list.length });
        return list;
      },
    );
    let channelAttempt = 0;
    for (const channel of channels) {
      channelAttempt += 1;
      // 渠道维限流（app 钩子；超限视同可换渠）
      if (deps.admitChannel != null && !(await deps.admitChannel(channel, estimatedTokens))) {
        lastCode = 'rate_limit_exceeded';
        await skipChannel(channel, channelAttempt, 'rate_limited');
        continue;
      }
      // 健康放行（熔断 open / 死凭据 invalid → 换渠；half-open 单探测赢家在此产生）
      const admission = await deps.health.admit(channelHealthKey(channel));
      if (!admission.ok) {
        lastCode = admission.reason;
        await skipChannel(channel, channelAttempt, admission.reason);
        continue;
      }
      // 渠道采购预算敞口预留（拒绝 = 该渠道预算耗尽，换渠）
      const reservation = await deps.trace.withSpan(
        'billing.reserve_channel',
        { 'request.id': requestId, 'channel.key': channel.channelName },
        () =>
          deps.billing.reserveChannel({
            requestId,
            channelId: channel.channelId,
            candidate,
            estimatedInputTokens: prepared.inputUpperBound,
            maxOutputTokens: prepared.outputCap,
          }),
      );
      if (!reservation.allowed) {
        lastCode = 'channel_budget_exhausted';
        await skipChannel(channel, channelAttempt, 'budget_exhausted');
        continue;
      }
      if (!leaseStarted) {
        await deps.billing.signal({
          type: 'upstream_started',
          requestId,
          leaseOwner: LEASE_OWNER,
          leaseMs: deps.defaults.authorization.ttlMs,
        });
        leaseStarted = true;
      }
      const outcome = await attempt({
        prepared,
        requestId,
        requestStartedAt,
        ...(signal != null ? { signal } : {}),
        candidate,
        channel,
        channelAttempt,
      });
      if (outcome.kind !== 'respond') lastCode = outcome.code;
      if (outcome.kind === 'switch_channel') continue;
      if (outcome.kind === 'next_candidate') break;
      return outcome.value;
    }
  }
  return releaseAndFail(deps, prepared, requestId, lastCode);
}

/**
 * 上游失败分派（非流式 / 流式首字节前共用——v1 dispatchFailure 迁移，
 * markDead 移除：死凭据经 AiEvent 由 health 状态机记账，C3/C4）：
 * 可换 → 换渠道；4xx → 透传终局（收尾后原码返回）；其余 → 换候选。
 */
export async function dispatchFailure(
  deps: ExecutionDeps,
  ctx: AttemptContext,
  error: UpstreamError,
): Promise<AttemptOutcome<PassthroughDelivered>> {
  const action = routeFailure(error);
  if (action === 'switch_channel') return { kind: 'switch_channel', code: error.kind };
  if (action === 'respond') {
    // 透传≠免收尾：4xx = 上游确定未计费 → request.failed 三路释放后原码返回
    const status =
      error.status != null && error.status >= 400 && error.status < 500 ? error.status : 502;
    const delivered = await deps.trace.withSpan(
      'billing.passthrough_4xx',
      {
        'request.id': ctx.requestId,
        'error.code': error.kind,
        'http.status_code': status,
      },
      async (span) => {
        span.setStatus({ code: 'error', message: error.kind });
        await deps.billing.signal({
          type: 'request_failed',
          requestId: ctx.requestId,
          reason: error.kind.slice(0, 64),
        });
        return {
          ok: true,
          passthrough: true,
          status,
          code: error.kind,
          ...(error.message !== error.kind ? { message: error.message } : {}),
        } as const;
      },
    );
    return { kind: 'respond', value: delivered };
  }
  return { kind: 'next_candidate', code: error.kind };
}

/** 全败收尾：request_failed 三路释放 + 渠道面竭尽/上游故障终结（v1 releaseAndFail） */
async function releaseAndFail(
  deps: ExecutionDeps,
  prepared: PreparedRequest,
  requestId: string,
  lastCode: string | undefined,
): Promise<never> {
  const exhausted = isChannelExhausted(lastCode);
  const reason = (exhausted ? 'no_available_channel' : (lastCode ?? 'no_available_channel')).slice(
    0,
    64,
  );
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
