/**
 * PAYG 来源（兜底，priority 100）：用户钱包余额 + 授信。
 * 套餐 Key 且开关 OFF 时执行不到本来源——订阅 probe 覆盖不足会先行抛错中断瀑布。
 */
import {
  availableToSpend,
  BILLING_REF_TYPE,
  Decimal,
  InsufficientBalanceError,
  InsufficientCashError,
} from '@ai-gateway/domain';
import type { DbTx, RepoContext, Repositories } from '@ai-gateway/repository';
import type { RunContext } from '../context.js';
import type { WalletApi } from '../wallet/wallet.js';
import type {
  FundingSource,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceSettleInput,
} from './source.js';

export function createPaygSource(deps: { wallet: WalletApi; repos: Repositories }): FundingSource {
  const type = 'payg' as const;
  return {
    type,
    priority: 100,

    applies: () => true,

    /** 可用额 = 余额 + 授信 − 在途（信用口径）；按计费币种挑账户，无该币种账户 = 0 */
    async probe(c: RepoContext, input: ProbeInput): Promise<Decimal> {
      const rows = await deps.repos.wallet.userAccountSummaries(c, input.userId);
      const account = rows.find(
        (row) => row.kind === 'user' && row.currency === input.context.currency,
      );
      if (!account) return new Decimal(0);
      return availableToSpend(account);
    },

    async reserve(c: RepoContext, input: ReserveInput): Promise<SourceReservation> {
      // §3.11 桥接：瀑布契约保证 c.db 是事务句柄——拆出 RunContext + tx 调钱包动词
      const { db: tx, ...ctx } = c;
      await deps.wallet.authorize(ctx as RunContext, {
        userId: input.userId,
        amount: input.amount,
        currency: input.context.currency,
        refType: BILLING_REF_TYPE,
        refId: input.requestId,
        memo: `billing reserve ${input.requestId}`,
        tx: tx as DbTx,
      });
      return {
        billingRequestId: input.requestId,
        sourceType: type,
        sourceRefId: null,
        amount: input.amount,
      };
    },

    async release(c: RepoContext, reservation: SourceReservation): Promise<void> {
      const { db: tx, ...ctx } = c;
      await deps.wallet.release(ctx as RunContext, {
        refType: BILLING_REF_TYPE,
        refId: reservation.billingRequestId,
        reason: 'billing_released',
        tx: tx as DbTx,
      });
    },

    async settle(c: RepoContext, input: SourceSettleInput): Promise<void> {
      const { db: tx, ...ctx } = c;
      // 超额（actual > Σ预留）：§4 补充授权——同事务补押差价并结算，再结清原单，
      // 总扣款 = consume + over = actual 精确；statement 呈现两笔结算。
      // 余额不足时降级收满预留（consume）：把「结算死信 + 预扣搁浅 + 平台吃全差」
      // 换成「足额收取预留 + 差额记损」——敞口被预扣口径钳制，损失有界。
      if (new Decimal(input.over).gt(0)) {
        try {
          await deps.wallet.authorize(ctx as RunContext, {
            userId: input.userId,
            amount: input.over,
            refType: BILLING_REF_TYPE,
            refId: `${input.requestId}#over`,
            memo: `billing over-hold ${input.requestId}`,
            tx: tx as DbTx,
          });
          await deps.wallet.settle(ctx as RunContext, {
            refType: BILLING_REF_TYPE,
            refId: `${input.requestId}#over`,
            amount: input.over,
            tx: tx as DbTx,
          });
        } catch (error) {
          if (!(error instanceof InsufficientBalanceError || error instanceof InsufficientCashError)) {
            throw error;
          }
          console.warn(
            `[payg] over-collect unavailable request=${input.requestId} over=${input.over} ` +
              `— collecting reserved only (bounded loss, no dead letter)`,
          );
        }
      }
      // consume ≤ hold；未用完的预留余量由 wallet.settle 隐式归还。
      // 0 元结算（缓存免费/上游全 0 usage）：settle 动词拒绝零额——改走全额释放，
      // 否则 InvalidAmountError 不属死信家族 → 10 轮重试全败 → dead + 预扣永久冻结。
      if (new Decimal(input.consume).lte(0)) {
        await deps.wallet.release(ctx as RunContext, {
          refType: BILLING_REF_TYPE,
          refId: input.requestId,
          reason: 'billing_settled_zero',
          tx: tx as DbTx,
        });
        return;
      }
      await deps.wallet.settle(ctx as RunContext, {
        refType: BILLING_REF_TYPE,
        refId: input.requestId,
        amount: input.consume,
        memo: `billing settle ${input.requestId}`,
        tx: tx as DbTx,
      });
    },
  };
}
