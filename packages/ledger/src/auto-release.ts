import { and, eq, lte, lt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import { Decimal, toDecimal } from '@ai-gateway/money';
import { BillingOperationError, type BillingOperations } from './billing-operations.js';

/**
 * 计费异常自动放行（复核队列减负，两条独立通道）：
 *
 *   - 小额通道：uncertain 且预扣 ≤ maxAmount → 放行（≤0 关闭）；
 *   - 时效通道（R11-B）：uncertain 且滞留超过 hours 且预扣 ≤ timeout.maxAmount
 *     → 放行（给预占上时间上界；双参数必须同时配置才启用，无默认值）。
 *     超过上限的大额滞留单不自动放——漏收决策显式留给人工。
 *   - dead 单永不自动处置（不变量被打破 = 缺陷信号，必须人工）。
 *
 * 每次放行走 resolveUncertain 正规命令（幂等 + 审计，actor=system），
 * revision 冲突说明有人先处理 → 静默跳过。两通道命中同一单只放一次。
 */

export interface BillingAutoReleaser {
  runOnce(): Promise<{ released: number; skipped: number; considered: number }>;
}

export interface AutoReleaseConfig {
  /** 小额通道金额阈值（元）；<= 0 关闭该通道 */
  maxAmount: string;
  /** 单次批量（每通道各取一批，去重后统一处置） */
  batchSize: number;
  /**
   * 小额通道最小滞留时长（毫秒，默认 60s）：刚转 uncertain 的单不立即放行——
   * 给在途结算/收据留窗口（recoverOnce 与本通道同 tick 运行时的竞态）。
   * 只放「滞留」单，与时效通道（R11-B）的 updatedAt 语义对齐。
   */
  minAgeMs?: number;
  /** 时效通道（R11-B）。未配置 = 关闭；配置后 hours 与 maxAmount 同时生效 */
  timeout?: { hours: number; maxAmount: string };
}

export function createBillingAutoReleaser(input: {
  db: Db;
  operations: BillingOperations;
  config: AutoReleaseConfig;
}): BillingAutoReleaser {
  const { db, operations } = input;
  const maxAmount = toDecimal(input.config.maxAmount);
  const enabled = maxAmount.gt(0);
  const batchSize = Math.max(1, Math.min(500, input.config.batchSize));
  const minAgeMs = Math.max(0, input.config.minAgeMs ?? 60_000);
  // 时效通道：双参数齐备才装配；上限必须为正（由 env 层与调用方保证，此处再守一道）
  const timeout =
    input.config.timeout && input.config.timeout.hours > 0
      ? { hours: input.config.timeout.hours, maxAmount: input.config.timeout.maxAmount }
      : undefined;
  const timeoutMaxAmount = timeout ? toDecimal(timeout.maxAmount) : new Decimal(0);

  return {
    async runOnce() {
      interface Candidate {
        requestId: string;
        revision: number;
        failureCode: string | null;
        reservedAmount: string;
        reason: string;
      }
      const candidates = new Map<string, Candidate>();

      const collect = async (
        threshold: Decimal,
        reason: (row: { reservedAmount: string }) => string,
        extra?: ReturnType<typeof lt>,
      ): Promise<number> => {
        const rows = await db
          .select({
            requestId: billingRequests.requestId,
            revision: billingRequests.revision,
            failureCode: billingRequests.failureCode,
            reservedAmount: billingRequests.reservedAmount,
          })
          .from(billingRequests)
          .where(
            and(
              eq(billingRequests.status, 'uncertain'),
              lte(billingRequests.reservedAmount, sql`${threshold.toString()}::numeric`),
              extra,
            ),
          )
          .limit(batchSize);
        for (const row of rows) {
          if (toDecimal(row.reservedAmount).gt(threshold)) continue; // 选取窗口与处置间的竞态，留给下一轮/人工
          if (!candidates.has(row.requestId)) {
            candidates.set(row.requestId, { ...row, reason: reason(row) });
          }
        }
        return rows.length;
      };

      let considered = 0;
      if (enabled) {
        const minAgeCutoff = new Date(Date.now() - minAgeMs);
        considered += await collect(
          maxAmount,
          (row) => `auto: 预扣 ${row.reservedAmount} 元 ≤ 阈值 ${maxAmount.toString()} 元，小额自动放行`,
          lt(billingRequests.updatedAt, minAgeCutoff),
        );
      }
      if (timeout) {
        const cutoff = new Date(Date.now() - timeout.hours * 3_600_000);
        considered += await collect(
          timeoutMaxAmount,
          (row) =>
            `auto: uncertain 滞留超过 ${timeout.hours}h 且预扣 ${row.reservedAmount} 元 ≤ 上限 ${timeoutMaxAmount.toString()} 元，时效放行`,
          lt(billingRequests.updatedAt, cutoff),
        );
      }

      let released = 0;
      let skipped = 0;
      for (const row of candidates.values()) {
        try {
          const result = await operations.resolveUncertain({
            operationId: `auto-release:${row.requestId}`,
            requestId: row.requestId,
            expectedRevision: row.revision,
            adminId: null,
            actor: 'system',
            decision: 'confirmed_no_charge',
            reason: row.reason,
          });
          if (!result.replayed) released += 1;
          else skipped += 1;
        } catch (error) {
          if (error instanceof BillingOperationError) {
            skipped += 1; // 状态/版本已被他人移动：不重试，交给下一轮或人工
            continue;
          }
          throw error;
        }
      }
      return { released, skipped, considered };
    },
};
}
