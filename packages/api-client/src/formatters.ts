/**
 * 数字与时间展示工具。
 * DB 现存「元」numeric 字符串（如 "49.999990000000000000"）。
 *   - 余额 / 流水 → 2 位小数
 *   - 单次费用 → 6 位小数（小额请求精确展示）
 *   - 模型单价 → 4 位小数
 *
 * 入参兼容 `string`（DB numeric 直接读出）/ `number`（计算后）。
 */

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

/** 通用格式化：digits 位小数，四舍五入 */
export function formatYuan(v: string | number | null | undefined, digits = 2): string {
  return toFiniteNumber(v).toFixed(digits);
}

/** 余额 / 流水展示（2 位小数） */
export function fmtBalance(v: string | number | null | undefined): string {
  return formatYuan(v, 2);
}

/** 单次费用展示（6 位小数） */
export function fmtCost(v: string | number | null | undefined): string {
  return formatYuan(v, 6);
}

/** 模型单价展示（元/百万 token，4 位小数） */
export function fmtPrice(v: string | number | null | undefined): string {
  return formatYuan(v, 4);
}

/** 整数展示 */
export function fmtInt(v: string | number | null | undefined): string {
  return Math.round(toFiniteNumber(v)).toString();
}

/** 毫秒 → 友好展示：<1s 显示 ms，>=1s 显示秒（保留 2 位） */
export function msToHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** ISO 日期字符串 → 本地时区 yyyy-MM-dd HH:mm */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 日期字符串 → 仅日期 yyyy-MM-dd */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
