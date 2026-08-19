import { and, eq, gt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests } from '@ai-gateway/db/schema';
import { pgSqlState } from '@ai-gateway/core';
import {
  AuthorizationNotActiveError,
  InsufficientBalanceError as WalletInsufficientBalanceError,
} from '@ai-gateway/wallet';
import {
  BillingInvariantError,
  BillingStateConflictError,
  PoisonReceiptError,
  ReceiptUserMismatchError,
} from '../platform/errors.js';
import type {
  BillingEffects,
  SettlementClaim,
  SettlementFailureClass,
  SettlementProcessorOptions,
} from '../billing/types.js';

/** 结算失败处置（拆自 processor.ts，行为零变更）：分类 → 重试/死信状态迁移 → 告警 effect。 */

/**
 * 结算失败分类（结构化判定，不做 message 文本启发式——文案变更不得改变分类）：
 *   - PG SQLSTATE 沿 cause 链探测（drizzle 包装后顶层无 code）
 *   - 收据校验失败 → PoisonReceiptError / ReceiptUserMismatchError（类型化）
 *   - 状态机冲突 → BillingStateConflictError（类型化）
 *   - JSON 解析失败（毒收据载荷）→ SyntaxError
 */
export function classifyFailure(error: unknown): SettlementFailureClass {
  const pg = error instanceof Error ? pgSqlState(error) : null;
  if (pg === '40001' || pg === '40P01') return 'serialization';
  // 23514 check_violation：wallet 内核资金不变量触底（账户/冻结单上的 DB check
  // 约束）。归为 invariant_violation（永久）→ dead，待人工处置后 retry。
  if (pg === '23514') return 'invariant_violation';
  if (pg?.startsWith('08') || ['53300', '57P01', '57P02', '57P03'].includes(pg ?? '')) {
    return 'db_transient';
  }
  if (error instanceof PoisonReceiptError || error instanceof SyntaxError) {
    return 'poison_receipt';
  }
  if (error instanceof ReceiptUserMismatchError) return 'poison_receipt';
  if (error instanceof BillingStateConflictError) return 'invariant_violation';
  // 账本不变量破坏是确定性失败（重试不可能自愈）→ 首次失败即 dead 转人工
  if (error instanceof BillingInvariantError) return 'invariant_violation';
  // wallet 侧资金事实触底/脱节（S5：补充授权跌破信用地板、冻结单状态不符）→
  // 等价旧 23514 语义：permanent → dead，人工处置后 retry
  if (error instanceof WalletInsufficientBalanceError) return 'invariant_violation';
  if (error instanceof AuthorizationNotActiveError) return 'invariant_violation';
  return 'unknown';
}

export function isPermanent(failure: SettlementFailureClass): boolean {
  return failure === 'poison_receipt' || failure === 'invariant_violation';
}

export function retryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(1, Math.floor(random() * ceiling));
}

/** 投影/告警 effect 的安全包装：2s 超时 + 吞错——失败不改变已提交的资金事务 */
export async function safeEffect(effect: (() => Promise<void>) | undefined): Promise<void> {
  if (!effect) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      effect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('billing effect timeout')), 2_000);
      }),
    ]);
  } catch {
    // 投影失败不改变已提交的资金事务。
  } finally {
    clearTimeout(timer);
  }
}

export async function finishFailure(
  db: Db,
  options: SettlementProcessorOptions,
  effects: BillingEffects | undefined,
  random: () => number,
  claimed: SettlementClaim,
  error: unknown,
): Promise<'retried' | 'dead' | 'claim_lost'> {
  const failureClass = classifyFailure(error);
  const dead = isPermanent(failureClass) || claimed.attempt >= options.maxAttempts;
  const nextAt = dead
    ? null
    : retryDelayMs(claimed.attempt, options.retryBaseMs, options.retryMaxMs, random);
  const changed = await db
    .update(billingRequests)
    .set({
      status: dead ? 'dead' : 'retry_wait',
      revision: sql`${billingRequests.revision} + 1`,
      nextSettlementAt: dead
        ? null
        : sql`clock_timestamp() + (${nextAt} * interval '1 millisecond')`,
      claimOwner: null,
      claimToken: null,
      claimUntil: null,
      failureClass,
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
      deadAt: dead ? sql`clock_timestamp()` : null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(billingRequests.requestId, claimed.requestId),
        eq(billingRequests.status, 'processing'),
        eq(billingRequests.claimToken, claimed.claimToken),
        eq(billingRequests.claimOwner, claimed.ownerId),
        eq(billingRequests.revision, claimed.revision),
        gt(billingRequests.claimUntil, sql`clock_timestamp()`),
      ),
    )
    .returning({ requestId: billingRequests.requestId, reservedAmount: billingRequests.reservedAmount });
  if (changed.length === 0) return 'claim_lost';
  if (dead) {
    await safeEffect(() =>
      effects?.requestDead?.({
        requestId: claimed.requestId,
        userId: (claimed.receipt as { userId?: number } | null)?.userId ?? 0,
        failureClass,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        reservedAmount: changed[0]!.reservedAmount,
        attempt: claimed.attempt,
      }) ?? Promise.resolve(),
    );
  }
  return dead ? 'dead' : 'retried';
}
