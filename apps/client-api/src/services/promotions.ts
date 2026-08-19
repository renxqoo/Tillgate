/**
 * 应用侧营销资金（S7 重写）：注册赠额/邀请奖励/佣金——wallet 之上的直接实现。
 * 幂等走 ledger-core（kinds 'signup.gift' / 'promo.*'）；资金 = wallet.credit
 * （counter-leg = outside 镜像，复式两端齐全）。
 */
import { eq } from 'drizzle-orm';
import { users } from '@ai-gateway/db/schema';
import type { Db } from '@ai-gateway/db';
import type { Wallet } from '@ai-gateway/wallet';
import { toDecimal, toStorage } from '@ai-gateway/wallet/metering';
import { createDomainOperations } from '@ai-gateway/ledger/platform';

export type PromoKind = 'signup.gift' | 'promo.referral_signup' | 'promo.referral_commission';

export interface PromoCreditResult {
  transactionId: number;
  amount: string;
  balanceAfter: string;
  replayed: boolean;
}

async function assertUser(db: Db, userId: number): Promise<void> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!row) throw new Error(`user_not_found:${userId}`);
}

export function createPromotions(db: Db, wallet: Wallet) {
  const operations = createDomainOperations(db, [
    'signup.gift',
    'promo.referral_signup',
    'promo.referral_commission',
  ]);

  return {
    /** 营销入账（邀请奖励/佣金）：operationId 即自然幂等键 */
    async grantCredit(input: {
      operationId: string;
      kind: PromoKind;
      userId: number;
      amount: string | number;
      remark?: string;
    }): Promise<PromoCreditResult> {
      const amount = toStorage(toDecimal(String(input.amount)));
      await assertUser(db, input.userId);
      const { receipt, replayed } = await operations.run({
        operationId: input.operationId,
        kind: input.kind,
        fingerprint: { kind: input.kind, userId: input.userId, amount },
        execute: async (tx) => {
          const posted = await wallet.credit({
            userId: input.userId,
            amount,
            refType: 'promo',
            refId: input.operationId,
            memo: input.remark,
            tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
          });
          return {
            transactionId: posted.transactionId,
            amount,
            balanceAfter: posted.balanceAfter,
          };
        },
      });
      return { ...receipt, replayed };
    },

    /**
     * 注册赠额：资格 = 从无任何资金历史（wallet 流水为空 = 全新用户）。
     * 重放非授予结果 → already_granted（区别于首跑 not_eligible）。
     */
    async grantSignupGift(input: {
      operationId: string;
      userId: number;
      amount: string | number;
    }): Promise<
      | ({ granted: true } & Omit<PromoCreditResult, 'replayed'> & { replayed: boolean })
      | { granted: false; reason: 'already_granted' | 'not_eligible' }
    > {
      const amount = toStorage(toDecimal(String(input.amount)));
      await assertUser(db, input.userId);
      const { receipt, replayed } = await operations.run<
        | { granted: true; transactionId: number; amount: string; balanceAfter: string }
        | { granted: false; reason: 'not_eligible' }
      >({
        operationId: input.operationId,
        kind: 'signup.gift',
        fingerprint: { kind: 'signup.gift', userId: input.userId, amount },
        execute: async (tx) => {
          const history = await wallet.statement({ userId: input.userId, limit: 1 });
          if (history.items.length > 0) return { granted: false as const, reason: 'not_eligible' as const };
          const posted = await wallet.credit({
            userId: input.userId,
            amount,
            refType: 'promo',
            refId: input.operationId,
            memo: '新用户赠送',
            tx: tx as unknown as import('@ai-gateway/wallet').DbLike,
          });
          return {
            granted: true as const,
            transactionId: posted.transactionId,
            amount,
            balanceAfter: posted.balanceAfter,
          };
        },
      });
      if (replayed && !receipt.granted) return { granted: false, reason: 'already_granted' };
      if (!receipt.granted) return receipt;
      return { ...receipt, replayed };
    },
  };
}

export type Promotions = ReturnType<typeof createPromotions>;
