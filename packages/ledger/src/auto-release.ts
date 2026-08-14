import { and, eq, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/money';
import { BillingOperationError, type BillingOperations } from './billing-operations.js';

/**
 * 计费异常「小额白名单自动放行」（复核队列减负通道）：
 *
 *   - 白名单码（证明上游未计费，如 429 透传残留）→ 无论金额一律放行；
 *   - 其余 uncertain（计量缺失 / 结果未知）→ 预扣 ≤ 阈值才放行；
 *   - dead 单永不自动处置（不变量被打破 = 缺陷信号，必须人工）。
 *
 * 每次放行走 resolveUncertain 正规命令（幂等 + 审计，actor=system），
 * revision 冲突说明有人先处理 → 静默跳过。阈值 ≤ 0 时整个通道关闭。
 */

/** 证明上游未计费的失败码（429 透传残留：08 修复前旧代码产生） */
const PROVEN_NO_CHARGE_CODES = ['rate_limit_error'];

export interface BillingAutoReleaser {
  runOnce(): Promise<{ released: number; skipped: number; considered: number }>;
}

export interface AutoReleaseConfig {
  /** 金额阈值（元）。白名单码不受限；<= 0 关闭整个自动通道 */
  maxAmount: string;
  /** 单次批量 */
  batchSize: number;
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

  return {
    async runOnce() {
      if (!enabled) return { released: 0, skipped: 0, considered: 0 };
      const candidates = await db
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
            or(
              inArray(billingRequests.failureCode, PROVEN_NO_CHARGE_CODES),
              lte(billingRequests.reservedAmount, sql`${maxAmount.toString()}::numeric`),
            ),
          ),
        )
        .limit(batchSize);

      let released = 0;
      let skipped = 0;
      for (const row of candidates) {
        const provenNoCharge =
          row.failureCode != null && PROVEN_NO_CHARGE_CODES.includes(row.failureCode);
        if (!provenNoCharge && toDecimal(row.reservedAmount).gt(maxAmount)) {
          skipped += 1; // 竞态窗口内金额/状态变化，留给人工
          continue;
        }
        try {
          const result = await operations.resolveUncertain({
            operationId: `auto-release:${row.requestId}`,
            requestId: row.requestId,
            expectedRevision: row.revision,
            adminId: null,
            actor: 'system',
            decision: 'confirmed_no_charge',
            reason: provenNoCharge
              ? 'auto: 失败码证明上游未计费（白名单），自动放行'
              : `auto: 预扣 ${row.reservedAmount} 元 ≤ 阈值 ${maxAmount.toString()} 元，小额自动放行`,
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
      return { released, skipped, considered: candidates.length };
    },
  };
}
