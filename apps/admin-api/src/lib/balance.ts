/**
 * 余额变更/资金流水/坏账解冻已抽到 @ai-gateway/billing（资损关键逻辑集中，防双写漂移）。
 * 本文件重新导出，保持现有 import 可用。新代码请直接 import @ai-gateway/billing。
 */
export {
  changeBalance,
  recordTransaction,
  unfreezeIfBadDebt,
  type BalanceChangeResult,
} from '@ai-gateway/billing';
