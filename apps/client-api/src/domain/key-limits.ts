/**
 * Key 限额输入纯规则：结构性拒绝（防「超大数字落到 numeric(38,18) 爆 500」）。
 * parsePositiveAmount 拒负数/NaN/科学计数法/
 * 超尺度；业务上界再收一层。
 */
import { parsePositiveAmount } from '@ai-gateway/domain';

/** 单 Key 每日消费上限的业务上界（元）——20 位整数能落库 ≠ 语义合理 */
export const DAILY_SPEND_LIMIT_MAX = '1000000000000';

export function isValidDailySpendLimitInput(raw: string): boolean {
  try {
    return parsePositiveAmount(raw).lessThan(DAILY_SPEND_LIMIT_MAX);
  } catch {
    return false;
  }
}
