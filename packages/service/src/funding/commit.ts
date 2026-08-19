/**
 * 瀑布② 提交（调用方事务内）：逐笔 reserve + 写 billing_reservations 明细行
 * （FK 要求账单行先插）。任一失败抛错 → 整体回滚（含前面来源已成功的预占，§3.7）。
 * 跨 user 订阅竞态由 tryReserveQuota 守卫 WHERE 兜底，输家回滚重试。
 */
import type { RepoContext, Repositories } from '@ai-gateway/repository';
import type { FundingPlan } from './plan.js';
import type { SourceReservation } from './source.js';

export async function commitFunding(
  c: RepoContext,
  repos: Repositories,
  plan: FundingPlan,
  input: { requestId: string; now: Date },
): Promise<SourceReservation[]> {
  const reservations: SourceReservation[] = [];
  for (const { source, take } of plan.entries) {
    const reservation = await source.reserve(c, {
      userId: plan.context.userId,
      requestId: input.requestId,
      amount: take.toString(),
      now: input.now,
      context: plan.context,
    });
    await repos.billingReservation.insertActive(c, reservation);
    reservations.push(reservation);
  }
  return reservations;
}
