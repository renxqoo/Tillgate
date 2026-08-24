/**
 * PAYG 来源（兜底，priority 100）：用户钱包余额 + 授信。
 * 套餐 Key 且开关 OFF 时执行不到本来源——订阅 probe 覆盖不足会先行抛错中断瀑布。
 */
import { availableToSpend } from '../../../domain/wallet/exposure.js';
import { Decimal } from '../../../domain/money.js';
import { BILLING_REF_TYPE } from '../../wallet/authorize.js';
import type { WalletStore, WalletTx } from '../../../ports/wallet-store.js';
import type { WalletApi } from '../../wallet/wallet.js';
import type {
  FundingSource,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceSettleInput,
} from './source.js';

// eslint-disable-next-line max-lines-per-function -- PAYG 资金源动词事务体
export function createPaygSource(deps: {
  wallet: WalletApi;
  walletStore: WalletStore;
}): FundingSource {
  const type = 'payg' as const;
  return {
    type,
    priority: 100,

    applies: () => true,

    /** 可用额 = 余额 + 授信 − 在途（信用口径）；按计费币种挑账户，无该币种账户 = 0 */
    async probe(tx: WalletTx, input: ProbeInput): Promise<Decimal> {
      const rows = await deps.walletStore.userAccountSummaries(tx, input.userId);
      const account = rows.find(
        (row) => row.kind === 'user' && row.currency === input.context.currency,
      );
      if (!account) return new Decimal(0);
      return availableToSpend(account);
    },

    async reserve(tx: WalletTx, input: ReserveInput): Promise<SourceReservation> {
      await deps.wallet.authorize({
        userId: input.userId,
        amount: input.amount,
        currency: input.context.currency,
        refType: BILLING_REF_TYPE,
        refId: input.requestId,
        memo: `billing reserve ${input.requestId}`,
        tx,
      });
      return {
        billingRequestId: input.requestId,
        sourceType: type,
        sourceRefId: null,
        amount: input.amount,
      };
    },

    async release(tx: WalletTx, reservation: SourceReservation): Promise<void> {
      await deps.wallet.release({
        refType: BILLING_REF_TYPE,
        refId: reservation.billingRequestId,
        reason: 'billing_released',
        tx,
      });
    },

    async settle(tx: WalletTx, input: SourceSettleInput): Promise<void> {
      // 超额（actual > Σ预留）：补充授权——同事务补押差价并结算，再结清原单，
      // 总扣款 = consume + over = actual 精确；statement 呈现两笔结算。
      if (new Decimal(input.over).gt(0)) {
        await deps.wallet.authorize({
          userId: input.userId,
          amount: input.over,
          refType: BILLING_REF_TYPE,
          refId: `${input.requestId}#over`,
          memo: `billing over-hold ${input.requestId}`,
          collectOverage: true,
          tx,
        });
        await deps.wallet.settle({
          refType: BILLING_REF_TYPE,
          refId: `${input.requestId}#over`,
          amount: input.over,
          tx,
        });
      }
      // consume ≤ hold；未用完的预留余量由 wallet.settle 隐式归还。
      // 0 元结算（缓存免费/上游全 0 usage）：settle 动词拒绝零额——改走全额释放，
      // 否则零额拒绝不属死信家族 → 10 轮重试全败 → dead + 预扣永久冻结。
      if (new Decimal(input.consume).lte(0)) {
        await deps.wallet.release({
          refType: BILLING_REF_TYPE,
          refId: input.requestId,
          reason: 'billing_settled_zero',
          tx,
        });
        return;
      }
      await deps.wallet.settle({
        refType: BILLING_REF_TYPE,
        refId: input.requestId,
        amount: input.consume,
        memo: `billing settle ${input.requestId}`,
        tx,
      });
    },
  };
}
