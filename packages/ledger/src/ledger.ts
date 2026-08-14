import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import {
  fundOperations,
  redeemBatches,
  redeemCodes,
  transactions,
  users,
} from '@ai-gateway/db/schema';
import { Decimal, toDecimal, toStorage } from '@ai-gateway/money';
import { reconcileAll, reconcileUsageVsTransactions, reconcileUser } from './reconcile.js';
import type { SettleResult, UsageReceipt } from './types.js';
import type { Redis } from 'ioredis';
import { backfillTpm } from './settle.js';

export type MoneyInput = string | Decimal;

export interface LedgerAuditEvent {
  adminId?: number | null;
  actor?: 'admin' | 'system';
  action: string;
  targetType: string;
  targetId?: string | number | null;
  detail?: Record<string, unknown> | null;
}

export interface LedgerEffects {
  balanceChanged?(event: { userId: number; balanceAfter?: string }): Promise<void>;
  audit?(event: LedgerAuditEvent): Promise<void>;
  usageSettled?(event: { data: UsageReceipt; result: SettleResult }): Promise<void>;
}

export interface LedgerDeps {
  db: Db;
  effects?: LedgerEffects;
  clock?: () => Date;
}

/** Redis 只承载提交后的缓存失效与 TPM 回填，不参与资金事务。 */
export function createRedisLedgerEffects(redis: Redis): LedgerEffects {
  return {
    async balanceChanged({ userId }) {
      await redis.del(`billing:balance:${userId}`);
    },
    async usageSettled({ data }) {
      await backfillTpm(redis, data);
    },
  };
}

export interface BalanceMutationResult {
  transactionId: number;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export type SignupGiftResult =
  | ({ granted: true } & BalanceMutationResult)
  | { granted: false; reason: 'already_granted' | 'not_eligible' };

export type RedeemResult =
  | ({ ok: true; codeId: number } & BalanceMutationResult)
  | {
      ok: false;
      reason: 'invalid_code' | 'code_already_used' | 'code_revoked' | 'code_expired';
    };

export class LedgerError extends Error {
  constructor(
    public readonly code:
      | 'user_not_found'
      | 'insufficient_balance'
      | 'invalid_amount'
      | 'idempotency_conflict',
    message: string = code,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface Ledger {
  getBalance(userId: number): Promise<string>;
  adminGift(input: {
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult>;
  adminAdjust(input: {
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult>;
  grantSignupGift(input: { userId: number; amount: MoneyInput }): Promise<SignupGiftResult>;
  redeemCode(input: { userId: number; code: string }): Promise<RedeemResult>;
  reconcile(input?: {
    scope?: 'all' | 'user' | 'usage';
    userId?: number;
    recentDays?: number;
  }): Promise<{ checkedUsers: number; discrepancies: number }>;
}

type StoredMutation = Omit<BalanceMutationResult, 'replayed'>;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fingerprint(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function normalizeAmount(value: MoneyInput, allowNegative: boolean): string {
  let amount: Decimal;
  try {
    amount = toDecimal(value);
  } catch {
    throw new LedgerError('invalid_amount');
  }
  if (!amount.isFinite() || amount.isZero() || (!allowNegative && amount.isNegative())) {
    throw new LedgerError('invalid_amount');
  }
  return toStorage(amount);
}

async function runEffect(effect: (() => Promise<void>) | undefined): Promise<void> {
  if (!effect) return;
  try {
    await effect();
  } catch {
    // PostgreSQL 已提交；临时副作用失败不能改变资金结果。
  }
}

export function createLedger({ db, effects, clock = () => new Date() }: LedgerDeps): Ledger {
  async function mutateBalance(input: {
    kind: 'admin.adjust' | 'admin.gift';
    operationId: string;
    userId: number;
    amount: MoneyInput;
    adminId: number | null;
    remark?: string;
  }): Promise<BalanceMutationResult> {
    const amount = normalizeAmount(input.amount, input.kind === 'admin.adjust');
    const fp = fingerprint({
      kind: input.kind,
      userId: input.userId,
      amount,
      adminId: input.adminId,
      remark: input.remark ?? null,
    });

    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(fundOperations)
        .values({ operationId: input.operationId, kind: input.kind, fingerprint: fp })
        .onConflictDoNothing({ target: fundOperations.operationId })
        .returning({ operationId: fundOperations.operationId });

      if (inserted.length === 0) {
        const existing = await tx.query.fundOperations.findFirst({
          where: eq(fundOperations.operationId, input.operationId),
        });
        if (!existing || existing.kind !== input.kind || existing.fingerprint !== fp) {
          throw new LedgerError('idempotency_conflict');
        }
        if (!existing.result) throw new LedgerError('idempotency_conflict', 'operation incomplete');
        return { ...(existing.result as StoredMutation), replayed: true };
      }

      const amountDec = new Decimal(amount);
      // 信用模型：扣减（负向调账）只要求 balance 不跌破 -credit_limit（由 DB 约束兜底），
      // 不再要求覆盖在途敞口（reserved_balance 是熔断敞口，非冻结）。
      const where = amountDec.isNegative()
        ? sql`${users.id} = ${input.userId}
              and ${users.balance} + ${amount}::numeric >= -${users.creditLimit}`
        : eq(users.id, input.userId);
      const updated = await tx
        .update(users)
        .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
        .where(where)
        .returning({ balance: users.balance });
      if (updated.length === 0) {
        const user = await tx.query.users.findFirst({
          where: eq(users.id, input.userId),
          columns: { id: true },
        });
        throw new LedgerError(user ? 'insufficient_balance' : 'user_not_found');
      }

      const balanceAfter = updated[0]!.balance;
      const balanceBefore = toStorage(new Decimal(balanceAfter).minus(amountDec));
      if (amountDec.isPositive()) {
        await tx
          .update(users)
          .set({ freezeReason: null, updatedAt: clock() })
          .where(
            sql`${users.id} = ${input.userId} and ${users.freezeReason} = 'bad_debt' and ${users.status} = 1`,
          );
      }
      const [entry] = await tx
        .insert(transactions)
        .values({
          userId: input.userId,
          type: input.kind === 'admin.gift' ? 'gift' : 'manual',
          amount,
          balanceBefore,
          balanceAfter,
          refType: input.kind === 'admin.gift' ? 'admin_gift' : 'admin_adjust',
          refId: input.operationId,
          remark: input.remark ?? null,
          createdBy: input.adminId,
        })
        .returning({ id: transactions.id });
      const stored: StoredMutation = {
        transactionId: entry!.id,
        amount,
        balanceBefore,
        balanceAfter,
      };
      await tx
        .update(fundOperations)
        .set({ transactionId: entry!.id, result: stored })
        .where(eq(fundOperations.operationId, input.operationId));
      return { ...stored, replayed: false };
    });

    if (!result.replayed) {
      await runEffect(
        () =>
          effects?.balanceChanged?.({ userId: input.userId, balanceAfter: result.balanceAfter }) ??
          Promise.resolve(),
      );
      await runEffect(
        () =>
          effects?.audit?.({
            adminId: input.adminId,
            action: input.kind === 'admin.gift' ? 'user.gift' : 'user.adjust',
            targetType: 'user',
            targetId: input.userId,
            detail: {
              amount: result.amount,
              before: result.balanceBefore,
              after: result.balanceAfter,
            },
          }) ?? Promise.resolve(),
      );
    }
    return result;
  }

  return {
    async getBalance(userId) {
      const user = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { balance: true },
      });
      return user?.balance ?? '0';
    },

    adminGift(input) {
      return mutateBalance({ ...input, kind: 'admin.gift' });
    },

    adminAdjust(input) {
      return mutateBalance({ ...input, kind: 'admin.adjust' });
    },

    async grantSignupGift(input) {
      const amount = normalizeAmount(input.amount, false);
      const operationId = `signup-gift:${input.userId}`;
      // 资格是一次性的自然键；配置金额日后变化时，已赠送用户仍应重放首次结果。
      const fp = fingerprint({ kind: 'signup.gift', userId: input.userId });
      const result = await db.transaction(async (tx): Promise<SignupGiftResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'signup.gift', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp)
            throw new LedgerError('idempotency_conflict');
          if (existing.result && (existing.result as { granted?: boolean }).granted) {
            const stored = existing.result as Extract<SignupGiftResult, { granted: true }>;
            return { ...stored, replayed: true };
          }
          return { granted: false, reason: 'already_granted' };
        }

        const [history] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(transactions)
          .where(eq(transactions.userId, input.userId));
        if (Number(history?.count ?? 0) > 0) {
          const skipped = { granted: false as const, reason: 'not_eligible' as const };
          await tx
            .update(fundOperations)
            .set({ result: skipped })
            .where(eq(fundOperations.operationId, operationId));
          return skipped;
        }

        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${amount}::numeric`, updatedAt: clock() })
          .where(sql`${users.id} = ${input.userId} and ${users.balance} = 0`)
          .returning({ balance: users.balance });
        if (updated.length === 0) {
          const skipped = { granted: false as const, reason: 'not_eligible' as const };
          await tx
            .update(fundOperations)
            .set({ result: skipped })
            .where(eq(fundOperations.operationId, operationId));
          return skipped;
        }
        const balanceAfter = updated[0]!.balance;
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'gift',
            amount,
            balanceBefore: '0',
            balanceAfter,
            refType: 'signup_gift',
            refId: operationId,
            remark: `新用户赠送 ${amount}`,
          })
          .returning({ id: transactions.id });
        const applied = {
          granted: true as const,
          transactionId: entry!.id,
          amount,
          balanceBefore: '0',
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.granted && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({
              userId: input.userId,
              balanceAfter: result.balanceAfter,
            }) ?? Promise.resolve(),
        );
        await runEffect(
          () =>
            effects?.audit?.({
              adminId: null,
              actor: 'system',
              action: 'user.signup_gift',
              targetType: 'user',
              targetId: input.userId,
              detail: { amount: result.amount },
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async redeemCode(input) {
      const codeHash = sha256(input.code);
      const operationId = `redeem:${codeHash}:${input.userId}`;
      const fp = fingerprint({ kind: 'redeem', userId: input.userId, codeHash });
      const result = await db.transaction(async (tx): Promise<RedeemResult> => {
        const inserted = await tx
          .insert(fundOperations)
          .values({ operationId, kind: 'redeem', fingerprint: fp })
          .onConflictDoNothing({ target: fundOperations.operationId })
          .returning({ operationId: fundOperations.operationId });
        if (inserted.length === 0) {
          const existing = await tx.query.fundOperations.findFirst({
            where: eq(fundOperations.operationId, operationId),
          });
          if (!existing || existing.fingerprint !== fp)
            throw new LedgerError('idempotency_conflict');
          if (!existing.result)
            throw new LedgerError('idempotency_conflict', 'operation incomplete');
          const stored = existing.result as RedeemResult;
          return stored.ok ? { ...stored, replayed: true } : stored;
        }

        const claimed = await tx
          .update(redeemCodes)
          .set({ status: 1, usedBy: input.userId, usedAt: clock() })
          .where(
            and(
              eq(redeemCodes.codeHash, codeHash),
              eq(redeemCodes.status, 0),
              sql`${redeemCodes.expiresAt} is null or ${redeemCodes.expiresAt} > ${clock()}`,
            ),
          )
          .returning({ id: redeemCodes.id, batchId: redeemCodes.batchId });
        if (claimed.length === 0) {
          const row = await tx.query.redeemCodes.findFirst({
            where: eq(redeemCodes.codeHash, codeHash),
          });
          const reason: Extract<RedeemResult, { ok: false }>['reason'] = !row
            ? 'invalid_code'
            : row.status === 1
              ? 'code_already_used'
              : row.status === 2
                ? 'code_revoked'
                : 'code_expired';
          const rejected = { ok: false as const, reason };
          await tx
            .update(fundOperations)
            .set({ result: rejected })
            .where(eq(fundOperations.operationId, operationId));
          return rejected;
        }
        const code = claimed[0]!;
        const [batch] = await tx
          .update(redeemBatches)
          .set({ usedCount: sql`${redeemBatches.usedCount} + 1` })
          .where(eq(redeemBatches.id, code.batchId))
          .returning({ amount: redeemBatches.amount });
        if (!batch) throw new Error(`batch_not_found:${code.batchId}`);
        const updated = await tx
          .update(users)
          .set({ balance: sql`${users.balance} + ${batch.amount}::numeric`, updatedAt: clock() })
          .where(eq(users.id, input.userId))
          .returning({ balance: users.balance });
        if (updated.length === 0) throw new LedgerError('user_not_found');
        const balanceAfter = updated[0]!.balance;
        const balanceBefore = toStorage(new Decimal(balanceAfter).minus(batch.amount));
        await tx
          .update(users)
          .set({ freezeReason: null, updatedAt: clock() })
          .where(
            sql`${users.id} = ${input.userId} and ${users.freezeReason} = 'bad_debt' and ${users.status} = 1`,
          );
        const [entry] = await tx
          .insert(transactions)
          .values({
            userId: input.userId,
            type: 'redeem',
            amount: batch.amount,
            balanceBefore,
            balanceAfter,
            refType: 'redeem_codes',
            refId: String(code.id),
            remark: `充值码兑换 +${batch.amount}`,
          })
          .returning({ id: transactions.id });
        const applied = {
          ok: true as const,
          codeId: code.id,
          transactionId: entry!.id,
          amount: batch.amount,
          balanceBefore,
          balanceAfter,
          replayed: false,
        };
        await tx
          .update(fundOperations)
          .set({ transactionId: entry!.id, result: applied })
          .where(eq(fundOperations.operationId, operationId));
        return applied;
      });
      if (result.ok && !result.replayed) {
        await runEffect(
          () =>
            effects?.balanceChanged?.({
              userId: input.userId,
              balanceAfter: result.balanceAfter,
            }) ?? Promise.resolve(),
        );
      }
      return result;
    },

    async reconcile(input = {}) {
      if (input.scope === 'user' && input.userId !== undefined) {
        return { checkedUsers: 1, discrepancies: (await reconcileUser(db, input.userId)) ? 0 : 1 };
      }
      if (input.scope === 'usage' && input.userId !== undefined) {
        return {
          checkedUsers: 1,
          discrepancies: (await reconcileUsageVsTransactions(db, input.userId)) ? 0 : 1,
        };
      }
      return reconcileAll(db, input.recentDays);
    },
  };
}
