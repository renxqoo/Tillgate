/**
 * 通用资金钱包（两阶段账本，业务无关）：
 *
 *   credit     入账（充值/赠送/返佣）——(refType, refId, 'credit') 幂等
 *   authorize  冻结/预占——(refType, refId) 幂等；可用口径 = balance − in_flight
 *   settle     实扣落定——CAS active→settled，可少于冻结额（余量即释放）；重放返回首次结果
 *   release    释放（取消/失败）——余额不动，in_flight 归还；已释放重放为 no-op
 *   refund     退款——余额守卫（balance ≥ amount）；独立幂等域
 *   balance    查询
 *   releaseExpired  超时扫描——expires_at 到点的 active 冻结转 expired 并归还 in_flight
 *
 * 资金不变量（DB check 兜底 + 代码保证）：
 *   ① 每笔冻结必达终态（settled/released/expired），settle/release 互斥（CAS）
 *   ② 流水链恒等 balance_after = balance_before + amount
 *   ③ balance、in_flight 恒非负；settle 不得超过冻结额
 *   ④ 同一业务键同一动作至多一条流水（唯一索引）
 *
 * 业务约定：金额恒为字符串（Decimal 全精度，永不 round）；调用方只带
 * userId + 金额 + 幂等键（refType/refId），资金安全全部由本包承担。
 */
import { and, eq, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { Decimal, isValidAmountString, normalizeAmount, toStorage } from './money';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  InsufficientBalanceError,
  InvalidAmountError,
  SettleExceedsHoldError,
} from './errors';
import { walletAccounts, walletAuthorizations, walletTransactions } from './schema';

/** 正金额（字符串十进制，>0，≤18 位小数） */
const amountSchema = z.string().refine((v) => isValidAmountString(v) && new Decimal(v).gt(0), {
  message: '金额必须为正的十进制字符串（≤18 位小数）',
});

const refTypeSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_]*$/, {
  message: 'refType 须为 snake_case 业务域标识',
});
const refIdSchema = z.string().min(1).max(128);

export interface CreditInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  memo?: string;
}

export interface AuthorizeInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  /** 冻结时限；到点由 releaseExpired 释放（worker 周期调用） */
  expiresAt?: Date;
  memo?: string;
}

export interface SettleInput {
  /** 按业务键结算（与 authorize 同 refType/refId） */
  refType: string;
  refId: string;
  /** 实扣金额（可少于冻结额，余量自动归还）；重放时忽略 */
  amount: string;
  memo?: string;
}

export interface ReleaseInput {
  refType: string;
  refId: string;
  reason?: string;
}

export interface RefundInput {
  userId: number;
  amount: string;
  refType: string;
  refId: string;
  memo?: string;
}

export interface CreditResult {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

export interface AuthorizeResult {
  authorizationId: string;
  amount: string;
  status: 'active' | 'settled' | 'released' | 'expired';
  expiresAt: string | null;
  replayed: boolean;
}

export interface SettleResult {
  authorizationId: string;
  settledAmount: string;
  balanceAfter: string;
  /** 冻结额与实扣之差（即随结算归还的余量） */
  releasedRemainder: string;
  replayed: boolean;
}

export interface ReleaseResult {
  authorizationId: string;
  amount: string;
  reason: string;
  replayed: boolean;
}

export interface Wallet {
  credit(input: CreditInput): Promise<CreditResult>;
  authorize(input: AuthorizeInput): Promise<AuthorizeResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  release(input: ReleaseInput): Promise<ReleaseResult>;
  refund(input: RefundInput): Promise<CreditResult>;
  balance(userId: number): Promise<string>;
  /** 超时释放扫描（worker 周期调用）；返回本次释放条数 */
  releaseExpired(now?: Date, limit?: number): Promise<{ released: number }>;
}

/** PG 唯一约束冲突（并发重放双保险的兜底信号）——drizzle 会包一层 cause，逐层探查 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current; depth += 1) {
    if ((current as { code?: string }).code === '23505') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** 事务句柄类型（drizzle tx 与 db 同构子集） */
type Tx = Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

/** 建户（无则插入）+ 行锁；返回锁定的账户行 */
async function lockAccount(tx: Tx, userId: number): Promise<{ balance: string; inFlight: string }> {
  await tx.insert(walletAccounts).values({ userId }).onConflictDoNothing();
  const [row] = await tx
    .select({ balance: walletAccounts.balance, inFlight: walletAccounts.inFlight })
    .from(walletAccounts)
    .where(eq(walletAccounts.userId, userId))
    .for('update');
  if (!row) throw new Error('wallet account lock failed');
  return row;
}

export function createWallet(db: NodePgDatabase): Wallet {
  const parseAmount = (value: string): Decimal => {
    const parsed = z.object({ amount: amountSchema }).safeParse({ amount: value });
    if (!parsed.success) throw new InvalidAmountError(value);
    return new Decimal(value);
  };

  /** 冻结终态迁移（CAS active → terminal）：余额不动、in_flight 归还、零额审计流水 */
  async function transitionRelease(
    refType: string,
    refId: string,
    reason: string,
    terminal: 'released' | 'expired',
  ): Promise<ReleaseResult> {
    return db.transaction(async (tx) => {
      const claimed = await tx
        .update(walletAuthorizations)
        .set({ status: terminal, releaseReason: reason, updatedAt: new Date() })
        .where(
          and(
            eq(walletAuthorizations.refType, refType),
            eq(walletAuthorizations.refId, refId),
            eq(walletAuthorizations.status, 'active'),
          ),
        )
        .returning({
          id: walletAuthorizations.id,
          userId: walletAuthorizations.userId,
          amount: walletAuthorizations.amount,
        });
      if (claimed.length === 0) {
        const auth = await findAuthorization(tx, refType, refId);
        if (!auth) throw new AuthorizationNotFoundError(refType, refId);
        if (auth.status === 'released' || auth.status === 'expired') {
          return {
            authorizationId: auth.id,
            amount: auth.amount,
            reason: auth.releaseReason ?? reason,
            replayed: true,
          };
        }
        throw new AuthorizationNotActiveError(refType, refId, auth.status);
      }
      const claim = claimed[0];
      if (!claim) throw new Error('wallet release cas returned empty');
      const account = await lockAccount(tx, claim.userId);
      const inFlightAfter = new Decimal(account.inFlight).minus(claim.amount);
      await tx.insert(walletTransactions).values({
        userId: claim.userId,
        kind: 'release',
        refType,
        refId,
        amount: '0',
        balanceBefore: account.balance,
        balanceAfter: account.balance,
        authorizationId: claim.id,
        memo: reason,
      });
      await tx
        .update(walletAccounts)
        .set({ inFlight: toStorage(inFlightAfter), updatedAt: new Date() })
        .where(eq(walletAccounts.userId, claim.userId));
      return {
        authorizationId: claim.id,
        amount: claim.amount,
        reason,
        replayed: false,
      };
    });
  }

  const wallet: Wallet = {
    async credit(input) {
      z.object({
        userId: z.number().int().positive(),
        refType: refTypeSchema,
        refId: refIdSchema,
      }).parse({ userId: input.userId, refType: input.refType, refId: input.refId });
      const amount = parseAmount(input.amount);

      try {
        return await db.transaction(async (tx) => {
          const account = await lockAccount(tx, input.userId);
          const balanceBefore = new Decimal(account.balance);
          const balanceAfter = balanceBefore.plus(amount);
          const [row] = await tx
            .insert(walletTransactions)
            .values({
              userId: input.userId,
              kind: 'credit',
              refType: input.refType,
              refId: input.refId,
              amount: toStorage(amount),
              balanceBefore: account.balance,
              balanceAfter: toStorage(balanceAfter),
              memo: input.memo,
            })
            .returning({ id: walletTransactions.id });
          if (!row) throw new Error('wallet credit insert failed');
          await tx
            .update(walletAccounts)
            .set({ balance: toStorage(balanceAfter), updatedAt: new Date() })
            .where(eq(walletAccounts.userId, input.userId));
          return {
            transactionId: row.id,
            amount: normalizeAmount(input.amount),
            balanceAfter: toStorage(balanceAfter),
            replayed: false,
          };
        });
      } catch (error) {
        // 并发同键重放：另一路已入账——读回首次结果
        if (isUniqueViolation(error)) return replayMovement(db, input.refType, input.refId, 'credit');
        throw error;
      }
    },

    async authorize(input) {
      z.object({
        userId: z.number().int().positive(),
        refType: refTypeSchema,
        refId: refIdSchema,
      }).parse({ userId: input.userId, refType: input.refType, refId: input.refId });
      const amount = parseAmount(input.amount);

      try {
        return await db.transaction(async (tx) => {
          const account = await lockAccount(tx, input.userId);
          const balance = new Decimal(account.balance);
          const inFlight = new Decimal(account.inFlight);
          const available = balance.minus(inFlight);
          if (available.lt(amount)) {
            throw new InsufficientBalanceError(
              input.userId,
              toStorage(available),
              toStorage(amount),
            );
          }
          const [auth] = await tx
            .insert(walletAuthorizations)
            .values({
              userId: input.userId,
              refType: input.refType,
              refId: input.refId,
              amount: toStorage(amount),
              status: 'active',
              expiresAt: input.expiresAt ?? null,
            })
            .returning({ id: walletAuthorizations.id });
          if (!auth) throw new Error('wallet authorize insert failed');
          await tx
            .update(walletAccounts)
            .set({ inFlight: toStorage(inFlight.plus(amount)), updatedAt: new Date() })
            .where(eq(walletAccounts.userId, input.userId));
          const result: AuthorizeResult = {
            authorizationId: auth.id,
            amount: normalizeAmount(input.amount),
            status: 'active',
            expiresAt: input.expiresAt ? input.expiresAt.toISOString() : null,
            replayed: false,
          };
          return result;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const existing = await findAuthorization(db, input.refType, input.refId);
          if (existing) {
            const replay: AuthorizeResult = {
              authorizationId: existing.id,
              amount: existing.amount,
              status: existing.status as AuthorizeResult['status'],
              expiresAt: existing.expiresAt ? existing.expiresAt.toISOString() : null,
              replayed: true,
            };
            return replay;
          }
        }
        throw error;
      }
    },

    async settle(input) {
      z.object({ refType: refTypeSchema, refId: refIdSchema }).parse({
        refType: input.refType,
        refId: input.refId,
      });
      const settleAmount = parseAmount(input.amount);

      return db.transaction(async (tx) => {
        // CAS：active → settled（0 行 = 他路已处理：settled 重放、released/expired 拒绝）
        const claimed = await tx
          .update(walletAuthorizations)
          .set({
            status: 'settled',
            settledAmount: toStorage(settleAmount),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(walletAuthorizations.refType, input.refType),
              eq(walletAuthorizations.refId, input.refId),
              eq(walletAuthorizations.status, 'active'),
            ),
          )
          .returning({
            id: walletAuthorizations.id,
            userId: walletAuthorizations.userId,
            amount: walletAuthorizations.amount,
          });
        if (claimed.length === 0) {
          const auth = await findAuthorization(tx, input.refType, input.refId);
          if (!auth) throw new AuthorizationNotFoundError(input.refType, input.refId);
          if (auth.status === 'settled') {
            const [account] = await tx
              .select({ balance: walletAccounts.balance })
              .from(walletAccounts)
              .where(eq(walletAccounts.userId, auth.userId));
            return {
              authorizationId: auth.id,
              settledAmount: auth.settledAmount ?? '0',
              balanceAfter: account?.balance ?? '0',
              releasedRemainder: new Decimal(auth.amount)
                .minus(auth.settledAmount ?? '0')
                .toString(),
              replayed: true,
            };
          }
          throw new AuthorizationNotActiveError(input.refType, input.refId, auth.status);
        }
        const claim = claimed[0];
        if (!claim) throw new Error('wallet settle cas returned empty');
        const held = new Decimal(claim.amount);
        if (settleAmount.gt(held)) {
          throw new SettleExceedsHoldError(toStorage(held), input.amount);
        }

        const account = await lockAccount(tx, claim.userId);
        const balanceAfter = new Decimal(account.balance).minus(settleAmount);
        const inFlightAfter = new Decimal(account.inFlight).minus(held);
        await tx.insert(walletTransactions).values({
            userId: claim.userId,
            kind: 'settle',
            refType: input.refType,
            refId: input.refId,
            amount: toStorage(settleAmount.neg()),
            balanceBefore: account.balance,
            balanceAfter: toStorage(balanceAfter),
            authorizationId: claim.id,
            memo: input.memo,
          });
        await tx
          .update(walletAccounts)
          .set({
            balance: toStorage(balanceAfter),
            inFlight: toStorage(inFlightAfter),
            updatedAt: new Date(),
          })
          .where(eq(walletAccounts.userId, claim.userId));
        return {
          authorizationId: claim.id,
          settledAmount: normalizeAmount(input.amount),
          balanceAfter: toStorage(balanceAfter),
          releasedRemainder: toStorage(held.minus(settleAmount)),
          replayed: false,
        };
      });
    },

    async release(input) {
      z.object({ refType: refTypeSchema, refId: refIdSchema }).parse({
        refType: input.refType,
        refId: input.refId,
      });
      return transitionRelease(input.refType, input.refId, input.reason?.slice(0, 64) ?? 'released', 'released');
    },

    async refund(input) {
      z.object({
        userId: z.number().int().positive(),
        refType: refTypeSchema,
        refId: refIdSchema,
      }).parse({ userId: input.userId, refType: input.refType, refId: input.refId });
      const amount = parseAmount(input.amount);

      try {
        return await db.transaction(async (tx) => {
          const account = await lockAccount(tx, input.userId);
          const balance = new Decimal(account.balance);
          if (balance.lt(amount)) {
            throw new InsufficientBalanceError(input.userId, toStorage(balance), toStorage(amount));
          }
          const balanceAfter = balance.minus(amount);
          const [row] = await tx
            .insert(walletTransactions)
            .values({
              userId: input.userId,
              kind: 'refund',
              refType: input.refType,
              refId: input.refId,
              amount: toStorage(amount.neg()),
              balanceBefore: account.balance,
              balanceAfter: toStorage(balanceAfter),
              memo: input.memo,
            })
            .returning({ id: walletTransactions.id });
          if (!row) throw new Error('wallet refund insert failed');
          await tx
            .update(walletAccounts)
            .set({ balance: toStorage(balanceAfter), updatedAt: new Date() })
            .where(eq(walletAccounts.userId, input.userId));
          return {
            transactionId: row.id,
            amount: normalizeAmount(input.amount),
            balanceAfter: toStorage(balanceAfter),
            replayed: false,
          };
        });
      } catch (error) {
        if (isUniqueViolation(error)) return replayMovement(db, input.refType, input.refId, 'refund');
        throw error;
      }
    },

    async balance(userId) {
      z.object({ userId: z.number().int().positive() }).parse({ userId });
      const [row] = await db
        .select({ balance: walletAccounts.balance })
        .from(walletAccounts)
        .where(eq(walletAccounts.userId, userId));
      return row ? normalizeAmount(row.balance) : '0';
    },

    async releaseExpired(now = new Date(), limit = 100) {
      const expired = await db
        .select({ refType: walletAuthorizations.refType, refId: walletAuthorizations.refId })
        .from(walletAuthorizations)
        .where(
          and(
            eq(walletAuthorizations.status, 'active'),
            sql`${walletAuthorizations.expiresAt} is not null`,
            lte(walletAuthorizations.expiresAt, now),
          ),
        )
        .limit(limit);
      let released = 0;
      for (const item of expired) {
        try {
          const result = await transitionRelease(item.refType, item.refId, 'expired', 'expired');
          if (!result.replayed) released += 1;
        } catch (error) {
          if (!(error instanceof AuthorizationNotActiveError)) throw error;
        }
      }
      return { released };
    },
  };

  return wallet;
}

type DbLike = NodePgDatabase | Parameters<Parameters<NodePgDatabase['transaction']>[0]>[0];

async function findAuthorization(
  db: DbLike,
  refType: string,
  refId: string,
): Promise<{
  id: string;
  userId: number;
  amount: string;
  status: string;
  settledAmount: string | null;
  releaseReason: string | null;
  expiresAt: Date | null;
} | undefined> {
  const [row] = await db
    .select()
    .from(walletAuthorizations)
    .where(and(eq(walletAuthorizations.refType, refType), eq(walletAuthorizations.refId, refId)));
  return row;
}

/** 幂等重放：读回首条动作流水（credit/refund） */
async function replayMovement(
  db: NodePgDatabase,
  refType: string,
  refId: string,
  kind: 'credit' | 'refund',
): Promise<CreditResult> {
  const [row] = await db
    .select()
    .from(walletTransactions)
    .where(
      and(
        eq(walletTransactions.refType, refType),
        eq(walletTransactions.refId, refId),
        eq(walletTransactions.kind, kind),
      ),
    );
  if (!row) throw new Error(`unique violation but no ${kind} row for ${refType}/${refId}`);
  return {
    transactionId: row.id,
    amount: normalizeAmount(row.amount.replace('-', '')),
    balanceAfter: normalizeAmount(row.balanceAfter),
    replayed: true,
  };
}
