/**
 * 正负金额配色（随界面语言翻转）：
 *   zh —— 中式「红涨绿跌」：正数红、负数绿
 *   en（默认）—— 西式：正数绿、负数红
 * 零/无效值不着色。流水/兑换/佣金展示共用。
 */
export function signedAmountTone(amount: string | number, locale: string): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value) || value === 0) return '';
  const positive = value > 0;
  const up = locale === 'zh' ? 'text-destructive' : 'text-emerald-600 dark:text-emerald-400';
  const down = locale === 'zh' ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive';
  return positive ? up : down;
}
