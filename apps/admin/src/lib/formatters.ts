/**
 * 数字与时间展示工具。
 * DB 现存「元」numeric 字符串（如 "49.999990000000000000"）。
 * 所有金额统一展示 4 位小数，超出部分直接截断，绝不四舍五入。
 *
 * 入参兼容 `string`（DB numeric 直接读出）/ `number`（计算后）。
 */

export type MoneyValue = string | number | null | undefined;

const DEFAULT_MONEY_DIGITS = 4;
const MAX_MONEY_DIGITS = 20;
const MAX_EXPONENT = 10_000;

/** 按指数平移后的小数点位置切分数字串：全左（纯小数）/ 全右（纯整数）/ 中间 */
function placeDigits(digits: string, decimalIndex: number): { integer: string; fraction: string } {
  if (decimalIndex <= 0) {
    return { integer: '0', fraction: '0'.repeat(-decimalIndex) + digits };
  }
  if (decimalIndex >= digits.length) {
    return { integer: digits + '0'.repeat(decimalIndex - digits.length), fraction: '' };
  }
  return { integer: digits.slice(0, decimalIndex), fraction: digits.slice(decimalIndex) };
}

/** 把普通十进制或科学计数法拆成整数和小数部分，全程不经过 Number。 */
function splitDecimal(
  value: MoneyValue,
): { negative: boolean; integer: string; fraction: string } | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const matched = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(String(value).trim());
  if (!matched || (!matched[2] && !matched[3])) return null;

  const exponent = Number(matched[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) return null;

  const sourceInteger = matched[2] || '0';
  const sourceFraction = matched[3] ?? '';
  const digits = sourceInteger + sourceFraction;
  const { integer, fraction } = placeDigits(digits, sourceInteger.length + exponent);

  return {
    negative: matched[1] === '-',
    integer: integer.replace(/^0+(?=\d)/, ''),
    fraction,
  };
}

/**
 * 公共金额展示方法：固定 digits 位小数，超出部分直接向 0 截断，不做四舍五入。
 * 无效值按 0 展示；默认保留 4 位。
 */
export function formatMoney(value: MoneyValue, digits = DEFAULT_MONEY_DIGITS): string {
  const scale =
    Number.isInteger(digits) && digits >= 0 && digits <= MAX_MONEY_DIGITS
      ? digits
      : DEFAULT_MONEY_DIGITS;
  const decimal = splitDecimal(value) ?? { negative: false, integer: '0', fraction: '' };
  const fraction = decimal.fraction.slice(0, scale).padEnd(scale, '0');
  const isZero = /^0+$/.test(decimal.integer) && (fraction === '' || /^0+$/.test(fraction));
  const sign = decimal.negative && !isZero ? '-' : '';
  return `${sign}${decimal.integer}${scale > 0 ? `.${fraction}` : ''}`;
}

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === '') return 0;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : 0;
}

const padTwoDigits = (n: number): string => String(n).padStart(2, '0');

/** 余额 / 流水展示（4 位小数，截断） */
export function fmtBalance(v: MoneyValue): string {
  return formatMoney(v);
}

/** 单次费用展示（4 位小数，截断） */
export function fmtCost(v: MoneyValue): string {
  return formatMoney(v);
}

/** 模型单价展示（元/百万 token，4 位小数，截断） */
export function fmtPrice(v: MoneyValue): string {
  return formatMoney(v);
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
  return `${d.getFullYear()}-${padTwoDigits(d.getMonth() + 1)}-${padTwoDigits(d.getDate())} ${padTwoDigits(d.getHours())}:${padTwoDigits(d.getMinutes())}`;
}

/** ISO 日期字符串 → 仅日期 yyyy-MM-dd */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${padTwoDigits(d.getMonth() + 1)}-${padTwoDigits(d.getDate())}`;
}

/**
 * 积分 = 钱（元）× 固定汇率（纯展示层，不参与账本/结算）。
 * 1 元 = 100 积分（即 1 积分 = 1 分钱）；汇率是全局常量，日后可零成本调整
 * （不动数据库、不动历史流水，因为积分是钱的实时投影）。
 */
export const POINTS_PER_YUAN = 100;

/** 元 → 积分（number，仅展示换算）。 */
export function toPoints(value: MoneyValue): number {
  return toFiniteNumber(value) * POINTS_PER_YUAN;
}

/** 积分展示（2 位小数，截断，与 formatMoney 口径一致）。 */
export function formatPoints(value: MoneyValue): string {
  return formatMoney(toFiniteNumber(value) * POINTS_PER_YUAN, 2);
}

/** 计价单位词（用量列表展示：图片张/音频秒/语音字符/按次；en 用拉丁词） */
export function unitWord(
  pricingUnit: string | null | undefined,
  locale: 'en' | 'zh' = 'en',
): string {
  if (locale === 'zh') {
    switch (pricingUnit) {
      case 'image': {
        return '张';
      }
      case 'second': {
        return '秒';
      }
      case 'char': {
        return '字符';
      }
      case 'request': {
        return '次';
      }
      default: {
        return '单位';
      }
    }
  }
  switch (pricingUnit) {
    case 'image': {
      return 'image';
    }
    case 'second': {
      return 'sec';
    }
    case 'char': {
      return 'char';
    }
    case 'request': {
      return 'request';
    }
    default: {
      return 'unit';
    }
  }
}

/** 费率卡系数展示形："1.000"→"1"、"0.800"→"0.8"、"0.750"→"0.75"；
 * 整数原样（"10" 不被削尾）；非数值形状原样返回（不抛——后端 numeric 字符串可信但不设防） */
export function fmtCoefficient(value: string | null | undefined): string {
  const v = value?.trim() ?? '';
  if (v === '' || !/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (!v.includes('.')) return v;
  const stripped = v.replace(/0+$/, '').replace(/\.$/, '');
  return stripped === '' || stripped === '-' ? '0' : stripped;
}
