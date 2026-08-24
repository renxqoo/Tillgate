/**
 * 兑换码用例（迁移自旧仓 client-api redeem.service——从 app 下沉到能力包）：
 * 核销 CAS 与钱包入账同事务（入账失败核销一并回滚——码可重试，账不落空）。
 * 频率闸先记数（猜码攻击本身就该被计数）；limiter 不可达 → fail-closed。
 * 入账幂等锚 refType='redeem' + refId=`code:{id}`。
 */
import { createHash } from 'node:crypto';
import { BillingErrors } from '../../domain/errors.js';
import type { BillingStore } from '../../ports/billing-store.js';
import type { RateCounterPort, RedeemCodeStore } from '../../ports/payment-ports.js';
import type { WalletApi } from '../wallet/wallet.js';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface RedemptionDeps {
  store: BillingStore;
  codes: RedeemCodeStore;
  wallet: WalletApi;
  limiter: RateCounterPort;
  perMinuteLimit: number;
  /** 时钟（装配必填——零写死） */
  clock: () => Date;
}

export interface RedemptionApi {
  redeem(
    userId: number,
    input: { code: string },
  ): Promise<{ amount: string; balanceAfter: string; transactionId: number }>;
  history(
    userId: number,
    input: { page: number; limit: number },
  ): Promise<Array<{ codeId: number; batchName: string; amount: string; usedAt: Date | null }>>;
}

// eslint-disable-next-line max-lines-per-function -- 兑换编排事务体:核销→入账→回执顺序步骤
export function createRedemptionApi(deps: RedemptionDeps): RedemptionApi {
  const { store, codes, wallet } = deps;
  const { clock } = deps;

  return {
    async redeem(userId, input) {
      const code = input.code.trim();
      if (!code) {
        throw BillingErrors.business('invalid_code', { reason: 'empty' });
      }

      // 频率闸：先记数（每次尝试都计入配额——猜码攻击本身就该被计数）
      let n: number;
      try {
        n = await deps.limiter.hit(`redeem:${userId}`, 60);
      } catch {
        throw BillingErrors.business('rate_counter_unavailable', { action: 'redeem' });
      }
      if (n > deps.perMinuteLimit) {
        throw BillingErrors.business('redeem_rate_limited', { userId });
      }

      const codeHash = sha256Hex(code);
      const result = await store.transaction(async (tx) => {
        const claim = await codes.claim(tx, { codeHash, userId, now: clock() });
        if (!claim) {
          // 抢占失败 → 区分错误语义（无效 / 已用 / 吊销 / 过期）
          const row = await codes.findByCodeHash(tx, codeHash);
          if (!row) {
            throw BillingErrors.business('invalid_code', { reason: 'not_found' });
          }
          if (row.status === 2) {
            throw BillingErrors.business('code_revoked', { codeId: row.id });
          }
          if (row.status !== 0) {
            throw BillingErrors.business('code_already_used', { codeId: row.id });
          }
          throw BillingErrors.business('code_expired', { codeId: row.id });
        }
        return wallet.credit({
          userId,
          amount: claim.amount,
          refType: 'redeem',
          refId: `code:${claim.codeId}`,
          memo: `兑换码入账（批次 ${claim.batchId}）`,
          tx,
        });
      });

      return {
        amount: result.amount,
        balanceAfter: result.balanceAfter,
        transactionId: result.transactionId,
      };
    },

    async history(userId, input) {
      return store.read((conn) =>
        codes.listRedeemedByUser(conn, {
          userId,
          limit: input.limit,
          offset: (input.page - 1) * input.limit,
        }),
      );
    },
  };
}
