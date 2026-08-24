// 限流数值的展示与解析（纯函数，无 React 依赖）

import { formatMoney } from '@/lib/formatters';

function fmtLimit(v: number | null): string {
  return v === null ? '' : v.toLocaleString('en-US');
}

/** 元金额：NULL=不限；数值保留 2 位小数。 */
function fmtMoney(v: string | null | undefined, unlimited: string): string {
  if (v === null || v === undefined) return unlimited;
  return formatMoney(v);
}

/** 限流文本 → 正整数或 null（空 = 清除）；非法返回 undefined（调用方给文案） */
export function parseLimitText(v: string): number | null | undefined {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 && Number.isInteger(n) ? n : undefined;
}

/** 非负金额文本（\d+(.\d+)?）；空串 → null（合法清除），非法 → undefined */
export function parseAmountText(v: string): string | null | undefined {
  const trimmed = v.trim();
  if (trimmed === '') return null;
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : undefined;
}

export { fmtLimit, fmtMoney };
