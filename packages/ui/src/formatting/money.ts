// 金额格式化: locale 与币种必须装配注入(AGENT §0.3 零写死), 本模块不持有任何全局默认实例。
// 展示口径: format 接主单位数值, formatMinor 接最小单位整数(如"分");
// formatMinor 的精确界是 10^15(主单位转 double 后仍有 ≤15 位有效数字, 无浮点二次舍入),
// 超界抛错而不是给出错误金额。
export type MoneyTone = 'positive' | 'negative' | 'zero';

export type MoneyFormatter = {
  format(amount: number): string;
  formatMinor(units: number | bigint): string;
  toneOf(amount: number): MoneyTone;
};

export type MoneyFormatterOptions = {
  locale: string;
  currency: string;
  currencyDisplay?: 'symbol' | 'code' | 'narrowSymbol';
};

// 15 位十进制有效数字以内, units/10^digits 的 double 表示与其十进制真值在
// "格式化到 minorDigits 位"的输出上完全一致; 16 位起不保证(如 9007199254740991 分
// 会被浮点舍成 .90 而非 .91), 因此在整数安全界之外再收紧到本界。
const MINOR_EXACT_LIMIT = 10n ** 15n;

function assertFiniteAmount(amount: number): void {
  if (!Number.isFinite(amount)) {
    throw new Error(`money amount must be a finite number: ${amount}`);
  }
}

export function createMoneyFormatter(options: MoneyFormatterOptions): MoneyFormatter {
  const nf = new Intl.NumberFormat(options.locale, {
    style: 'currency',
    currency: options.currency,
    currencyDisplay: options.currencyDisplay ?? 'symbol',
  });
  const minorDigits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  const minorScale = 10 ** minorDigits;

  function format(amount: number): string {
    assertFiniteAmount(amount);
    return nf.format(amount);
  }

  function formatMinor(units: number | bigint): string {
    if (typeof units === 'number' && !Number.isInteger(units)) {
      throw new Error(`money minor units must be an integer: ${units}`);
    }
    // bigint 超出 number 可表示范围或逼近 2^53 时精度已不可信, 用统一精确界拦截
    if (
      typeof units === 'bigint'
        ? units >= MINOR_EXACT_LIMIT || units <= -MINOR_EXACT_LIMIT
        : Math.abs(units) >= Number(MINOR_EXACT_LIMIT)
    ) {
      throw new Error(`money minor units exceed the exact display range: ${units.toString()}`);
    }
    // 主单位 = units / 10^digits; 商的小数位数不超过 minorDigits,
    // 且在本精确界内 double 无二次舍入, Intl 按位格式化与十进制真值一致
    return format(Number(units) / minorScale);
  }

  function toneOf(amount: number): MoneyTone {
    assertFiniteAmount(amount);
    if (amount > 0) {
      return 'positive';
    }
    return amount < 0 ? 'negative' : 'zero';
  }

  return { format, formatMinor, toneOf };
}
