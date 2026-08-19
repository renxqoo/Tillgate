/**
 * 管理端资金服务（S7 重写）：调账/赠送/授信调整——wallet 之上的直接实现。
 *
 * 资金事实唯一在 wallet：正向 = wallet.credit（counter-leg = outside 镜像）；
 * 负向调账 = wallet.transfer(user→outside, allowCredit)——可用额守卫天然保住
 * 信用地板。幂等走 ledger-core（kinds 'admin.adjust' / 'admin.gift'）。
 * 授信调整 = wallet.setCreditLimit（users.credit_limit 列退役）。
 */
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Wallet } from '@ai-gateway/wallet';
import { OUTSIDE_ACCOUNT } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import {
  createDomainOperations,
  LedgerError,
  ledgerHttpError,
  type DomainOperations,
} from '@ai-gateway/ledger/platform';
import type { Db } from '@ai-gateway/db';

export interface MutationResult {
  userId: number;
  transactionId: number;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  replayed: boolean;
}

export function createAdminFunds(db: Db, wallet: Wallet): AdminFunds {
  const operations: DomainOperations = createDomainOperations(db, ['admin.adjust', 'admin.gift']);

  async function assertUser(userId: number): Promise<void> {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!row) throw new LedgerError('user_not_found');
  }

  return {
    async adjust(input) {
      const amount = toStorage(toDecimal(String(input.amount)));
      if (toDecimal(amount).isZero()) throw new LedgerError('invalid_amount');
      await assertUser(input.userId);
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind: 'admin.adjust',
        fingerprint: {
          kind: 'admin.adjust', userId: input.userId, amount,
          adminId: input.adminId, remark: input.remark ?? null,
        },
        execute: async (tx) => {
          if (toDecimal(amount).gt(0)) {
            const posted = await wallet.credit({
              userId: input.userId, amount,
              refType: 'admin', refId: input.operationId, memo: input.remark,
              tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
            });
            return {
              userId: input.userId, transactionId: posted.transactionId, amount,
              balanceBefore: toStorage(toDecimal(posted.balanceAfter).minus(amount)),
              balanceAfter: posted.balanceAfter,
            };
          }
          const positive = amount.replace('-', '');
          const posted = await wallet.transfer({
            from: { userId: input.userId }, to: { code: OUTSIDE_ACCOUNT },
            amount: positive,
            refType: 'admin', refId: input.operationId, memo: input.remark,
            allowCredit: true,
            tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
          });
          return {
            userId: input.userId, transactionId: posted.transactionId, amount,
            balanceBefore: toStorage(toDecimal(posted.fromBalanceAfter).plus(positive)),
            balanceAfter: posted.fromBalanceAfter,
          };
        },
      });
      return { ...receipt, replayed };
    },

    async gift(input) {
      const amount = toStorage(toDecimal(String(input.amount)));
      if (!toDecimal(amount).gt(0)) throw new LedgerError('invalid_amount');
      await assertUser(input.userId);
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind: 'admin.gift',
        fingerprint: {
          kind: 'admin.gift', userId: input.userId, amount,
          adminId: input.adminId, remark: input.remark ?? null,
        },
        execute: async (tx) => {
          const posted = await wallet.credit({
            userId: input.userId, amount,
            refType: 'admin', refId: input.operationId, memo: input.remark,
            tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
          });
          return {
            userId: input.userId, transactionId: posted.transactionId, amount,
            balanceBefore: toStorage(toDecimal(posted.balanceAfter).minus(amount)),
            balanceAfter: posted.balanceAfter,
          };
        },
      });
      return { ...receipt, replayed };
    },

    async setCreditLimit(input) {
      // 授信地板归 wallet（users.credit_limit 退役）；refId 唯一即可（PATCH 语义非幂等键复用）
      const posted = await wallet.setCreditLimit({
        userId: input.userId,
        amount: toStorage(toDecimal(String(input.amount))),
        refType: 'admin',
        refId: input.refId,
      });
      return { creditLimit: posted.creditLimit };
    },
  };
}

export interface AdminFunds {
  adjust(input: {
    operationId: string;
    userId: number;
    amount: string | number;
    adminId: number | null;
    remark?: string;
  }): Promise<MutationResult>;
  gift(input: {
    operationId: string;
    userId: number;
    amount: string | number;
    adminId: number | null;
    remark?: string;
  }): Promise<MutationResult>;
  setCreditLimit(input: { userId: number; amount: string | number; refId: string }): Promise<{ creditLimit: string }>;
}

/** 资金域错误 → HTTP（LedgerError/ChannelBudgetError/wallet 系统一表收口） */
export function mapMoneyError(error: unknown): unknown {
  return ledgerHttpError(error);
}
