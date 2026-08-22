/**
 * 渠道敞口预留决策（纯函数）：路由选渠前，就「目标渠道/预估成本 vs 当前认领」给三种模式。
 *   covered —— 同渠道且新预估 ≤ 已预留（无需任何变更）
 *   topup  —— 同渠道但预估更高（按差额补足，否则预算闸门被弱化）
 *   switch —— 新渠道（先守卫预留新 → 再释放旧 → 最后 CAS 认领——顺序编排在使用方）
 */
import { Decimal } from '../money.js';

export type ChannelReserveDecision =
  | { mode: 'covered' }
  | { mode: 'topup'; delta: string }
  | { mode: 'switch' };

export function reserveDecision(input: {
  currentChannelId: number | null;
  currentReserved: string | null;
  channelId: number;
  amount: Decimal;
}): ChannelReserveDecision {
  if (input.currentChannelId === input.channelId && input.currentReserved != null) {
    const delta = input.amount.minus(new Decimal(input.currentReserved));
    if (delta.lte(0)) return { mode: 'covered' };
    return { mode: 'topup', delta: delta.toString() };
  }
  return { mode: 'switch' };
}

/** 预算余量 = 进货额度 − 在途敞口（拒绝时的回执口径） */
export function budgetRemaining(budget: string, reserved: string): string {
  return new Decimal(budget).minus(new Decimal(reserved)).toString();
}
