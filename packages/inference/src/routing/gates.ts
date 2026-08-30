import type { ChannelCandidate, QuoteCandidate } from '../domain/model/types';
import { channelHealthKey, type ChannelHealth } from '../health/channel-health';
import type { RoutingMemory } from '../health/routing-memory';
import type { BillingPort } from '../ports/billing';
import type { TracePort } from '../ports/trace';
import type { PreparedRequest } from '../application/quote';
import type { ChannelAdmission } from '../application/failover';

/**
 * 渠道门管线（safety 面——固定顺序，不可插拔：策略管偏好，门管保护）：
 *   ① 渠道限流（app 钩子）→ ② host 熔断 + 死凭据(channel) → ③ 惩罚箱(条件门)
 *   → ④ 采购预算硬闸。
 *
 * 条件惩罚门（B1 修复）：候选仍有未惩罚渠道时跳过惩罚渠道（零重复撞击保留）；
 * 全渠道都在冷却时放行（惩罚是排序信号不是禁入——单渠道/全冷却场景不得假性 503，
 * 上游短暂限流靠同渠道退避重试扛过，重试预算由 policy.retry 提供）。
 */

/** 门依赖（ExecutionDeps 的结构子集——避免 application↔routing 类型环） */
export interface GateEnv {
  health: ChannelHealth;
  memory: RoutingMemory;
  billing: BillingPort;
  trace: TracePort;
  admitChannel?: ChannelAdmission;
}

export interface GateArgs {
  requestId: string;
  prepared: PreparedRequest;
  candidate: QuoteCandidate;
  channel: ChannelCandidate;
  channelAttempt: number;
  estimatedTokens: number;
}

/** 渠道跳过事实进 trace 不进响应 */
async function skipChannel(
  env: GateEnv,
  args: { requestId: string; channel: ChannelCandidate; channelAttempt: number; reason: string },
): Promise<void> {
  await env.trace.withSpan(
    'channel.skip',
    {
      'request.id': args.requestId,
      'channel.key': args.channel.channelName,
      'channel.attempt': args.channelAttempt,
      'skip.reason': args.reason,
    },
    async () => {},
  );
}

/**
 * 单渠道门：任一拒绝返回跳过码（lastCode 候选），全部通过返回 null。
 * penaltyEnforced = 候选存在未惩罚渠道（由调用方批量预解析）。
 */
// eslint-disable-next-line max-lines-per-function -- 门管线四段平铺：限流→健康→惩罚→预算，拆分需传递整体上下文
export async function gateChannel(input: {
  env: GateEnv;
  args: GateArgs;
  penaltyEnforced: boolean;
  /** 拒绝惩罚渠道前的现场复核：其余渠道是否已全部进入冷却（true = 放行当前渠道）。
   *  收窄快照竞态窗口——循环前快照与门内单读之间的并发惩罚记入由此兜住 */
  penaltyFallback?: (currentChannelId: number) => Promise<boolean>;
}): Promise<string | null> {
  const { env, args, penaltyEnforced, penaltyFallback } = input;
  const { requestId, prepared, candidate, channel, channelAttempt, estimatedTokens } = args;
  if (env.admitChannel != null && !(await env.admitChannel(channel, estimatedTokens, requestId))) {
    await skipChannel(env, { requestId, channel, channelAttempt, reason: 'rate_limited' });
    return 'rate_limit_exceeded';
  }
  const admission = await env.health.admit(channelHealthKey(channel), channel.channelId);
  if (!admission.ok) {
    await skipChannel(env, { requestId, channel, channelAttempt, reason: admission.reason });
    return admission.reason;
  }
  if (penaltyEnforced && (await env.memory.penalized(channel.channelId))) {
    // 现场复核：快照判定有活渠道，但快照到此刻之间其余渠道可能已被并发记入惩罚
    // ——全冷却则放行当前渠道（条件门语义在拒绝瞬间成立，而非整轮循环成立）
    const allOthersCooling = penaltyFallback != null && (await penaltyFallback(channel.channelId));
    if (!allOthersCooling) {
      await skipChannel(env, { requestId, channel, channelAttempt, reason: 'penalty' });
      return 'rate_limited';
    }
  }
  const reservation = await env.trace.withSpan(
    'billing.reserve_channel',
    { 'request.id': requestId, 'channel.key': channel.channelName },
    async (span) => {
      const r = await env.billing.reserveChannel({
        requestId,
        channelId: channel.channelId,
        candidate,
        estimatedInputTokens: prepared.inputUpperBound,
        maxOutputTokens: prepared.outputCap,
      });
      // 换渠转移/剩余额度进观测面（billing 返回的事实不得在桥接层丢弃）
      if (r.allowed) {
        span.setAttributes({
          ...(r.switched === true ? { 'billing.switched': true } : {}),
          ...(r.remaining != null ? { 'billing.remaining': r.remaining } : {}),
        });
      }
      return r;
    },
  );
  if (!reservation.allowed) {
    await skipChannel(env, { requestId, channel, channelAttempt, reason: 'budget_exhausted' });
    return 'channel_budget_exhausted';
  }
  return null;
}
