/**
 * 公开定价页展示格式化（纯函数，无 i18n 依赖——词表键由调用方解析）：
 * 计价单位目录键、单位价后缀键、金额/上下文的展示口径。
 * 与落地页模型广场共用同一「元/百万 Token」口径，避免同页两套数字口径。
 */

/** 空位占位符（价格缺失、上下文未知、非 token 制的互斥列） */
export const DASH = '—';

/** 计价方式 → pricing 命名空间的单位词表键；未知 unit 无键（调用方原样回显） */
export const PRICING_UNIT_KEYS: Record<string, string> = {
  token: 'unitToken',
  request: 'unitRequest',
  image: 'unitImage',
  second: 'unitSecond',
  char: 'unitChar',
};

/** 计价方式 → 非 token 制单位价后缀词表键（token 制走 ¥/1M 口径，无后缀） */
export const PRICING_UNIT_SUFFIX_KEYS: Record<string, string> = {
  request: 'perRequest',
  image: 'perImage',
  second: 'perSecond',
  char: 'perChar',
};

/** 十进制字符串 → number；缺失/空串/非数字返回 null（调用方渲染占位符） */
export function parseYuan(price?: string | null): number | null {
  if (!price) return null;
  const n = Number(price);
  return Number.isFinite(n) ? n : null;
}

/** 元金额展示：¥ + 去除多余尾零的十进制；null 渲染占位符 */
export function fmtYuan(value: number | null): string {
  if (value === null || value === 0) return DASH;
  return `¥${String(Number(value.toFixed(4)))}`;
}

/** 上下文长度 → 「262K」；缺失/0 渲染占位符 */
export function formatContextLength(n?: number | null): string {
  return n ? `${Math.round(n / 1000)}K` : DASH;
}

/** 计价单位词表键；未知 unit 返回 null（调用方原样回显单位字符串） */
export function unitLabelKey(unit: string): string | null {
  return PRICING_UNIT_KEYS[unit] ?? null;
}

/** 单位价后缀词表键；token 制与未知 unit 返回 null */
export function unitSuffixKey(unit: string): string | null {
  return PRICING_UNIT_SUFFIX_KEYS[unit] ?? null;
}
