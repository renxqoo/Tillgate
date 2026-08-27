// 数值格式化: locale 必须装配注入; 位数缺省沿用 Intl 各形态的展示默认
export interface NumberFormatter {
  format(value: number): string;
  formatCompact(value: number): string;
  // fraction 是比例值(0.123 → 12.3%), 不是百分数
  formatPercent(fraction: number, options?: { maximumFractionDigits?: number }): string;
}

export interface NumberFormatterOptions {
  locale: string;
  maximumFractionDigits?: number;
}

function assertFinite(value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error(`number value must be finite: ${value}`);
  }
}

export function createNumberFormatter(options: NumberFormatterOptions): NumberFormatter {
  const nf = new Intl.NumberFormat(options.locale, {
    maximumFractionDigits: options.maximumFractionDigits,
  });
  const compact = new Intl.NumberFormat(options.locale, {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: options.maximumFractionDigits,
  });

  function formatPercent(
    fraction: number,
    percentOptions?: { maximumFractionDigits?: number },
  ): string {
    assertFinite(fraction);
    return new Intl.NumberFormat(options.locale, {
      style: 'percent',
      maximumFractionDigits: percentOptions?.maximumFractionDigits,
    }).format(fraction);
  }

  return {
    format(value) {
      assertFinite(value);
      return nf.format(value);
    },
    formatCompact(value) {
      assertFinite(value);
      return compact.format(value);
    },
    formatPercent,
  };
}
