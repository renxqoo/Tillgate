/**
 * PAYG 来源（兜底，priority 100）：用户钱包余额 + 授信。
 * 套餐 Key 且开关 OFF 时执行不到本来源——订阅 probe 覆盖不足会先行抛错中断瀑布。
 */
import { availableToSpend } from '../../../domain/wallet/exposure.js';
import { overCollectCeiling } from './over-collect.js';
import { Decimal } from '../../../domain/money.js';
import { BILLING_REF_TYPE } from '../../wallet/authorize.js';
import { DefectError } from '@tillgate/errors';

/**
 * 超收段（F1——docs §4.3）：钳天花板补充授权 + 结算；并发败者重读钳制，
 * 差额 waived。返回放弃额。
 */
async function settleOverage(
  deps: { wallet: WalletApi; walletStore: WalletStore },
  tx: WalletTx,
  input: { requestId: string; userId: number; over: string },
): Promise<Decimal> {
  const over = new Decimal(input.over);
  if (!over.gt(0)) return new Decimal(0);
  let collectOver = Decimal.min(over, await overCollectCeiling(deps.walletStore, tx, input.userId));
  while (collectOver.gt(0)) {
    try {
      await deps.wallet.authorize({
        userId: input.userId,
        amount: collectOver.toString(),
        refType: BILLING_REF_TYPE,
        refId: `${input.requestId}#over`,
        memo: `billing over-hold ${input.requestId}`,
        collectOverage: true,
        tx,
      });
      await deps.wallet.settle({
        refType: BILLING_REF_TYPE,
        refId: `${input.requestId}#over`,
        amount: collectOver.toString(),
        tx,
      });
      break;
    } catch (error) {
      // 守卫失败（gate 家族）→ 钳到当前可收额重试一次；非守卫错误原样上抛
      if (!isOverageGuardFailure(error)) throw error;
      const retryCeiling = await overCollectCeiling(deps.walletStore, tx, input.userId);
      if (retryCeiling.gte(collectOver)) throw error; // 非并发占用——真异常
      collectOver = Decimal.min(over, retryCeiling);
    }
  }
  return over.minus(collectOver);
}

/**
 * #over 守卫失败家族：conditionalReserve 输家的 gate_unclassified /
 * 可用不足类业务错——并发占用的可期形态（F1）。结构不变量（account_missing
 * 等）与连接错误不算——那些上抛走失败处置。
 */
function isOverageGuardFailure(error: unknown): boolean {
  if (error instanceof DefectError) {
    const gateLoss = error.message.includes('gate_unclassified');
    const authorizeGate = error.code === 'billing.wallet_invariant' && error.message.includes('authorize.');
    return gateLoss || authorizeGate;
  }
  if (error instanceof Error) return /insufficient|available/i.test(error.message);
  return false;
}
import type { WalletStore, WalletTx } from '../../../ports/wallet-store.js';
import type { WalletApi } from '../../wallet/wallet.js';
import type {
  FundingSource,
  ProbeInput,
  ReserveInput,
  SourceReservation,
  SourceSettleInput,
  SourceSettleResult,
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

    async settle(tx: WalletTx, input: SourceSettleInput): Promise<SourceSettleResult> {
      // 超额（actual > Σ预留）：钳到可收额（可用 + 透支地板；见 over-collect.ts）
      // 补充授权——差额 waived 上报（落 waived_amount），结算恒成功不进死信。
      const waived = await settleOverage(deps, tx, input);
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
        return { waived: waived.toString() };
      }
      await deps.wallet.settle({
        refType: BILLING_REF_TYPE,
        refId: input.requestId,
        amount: input.consume,
        memo: `billing settle ${input.requestId}`,
        tx,
      });
      return { waived: waived.toString() };
    },
  };
}
