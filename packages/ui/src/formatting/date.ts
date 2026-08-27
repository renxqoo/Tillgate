// 日期时间格式化: locale(/时区)必须装配注入。
// 相对时间只覆盖一周以内, 更早/更晚回退为绝对日期(账单类控制台超出粒度后绝对日期更可读)。
export type DateInput = string | number | Date;

export interface DateFormatter {
  formatDate(input: DateInput): string;
  formatDateTime(input: DateInput): string;
  // now 可注入(测试/服务端预渲染), 缺省取当前时间
  formatRelative(input: DateInput, now?: Date): string;
}

export interface DateFormatterOptions {
  locale: string;
  timeZone?: string;
}

function toDate(input: DateInput): Date {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid date input: ${String(input)}`);
  }
  return date;
}

// 模块级分桶：把秒差映射为相对时间单位与值；返回 null 表示超出一周粒度、回退绝对日期
function relativeTimeBucket(diffSeconds: number): {
  value: number;
  unit: Intl.RelativeTimeFormatUnit;
} | null {
  // 分桶阈值: 与常见相对时间实践一致(45s/90s/45m/90m/22h/36h/7d)
  const past = diffSeconds < 0;
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 45) {
    return { value: diffSeconds, unit: 'second' };
  }
  if (absSeconds < 90) {
    return { value: past ? -1 : 1, unit: 'minute' };
  }
  const absMinutes = absSeconds / 60;
  if (absMinutes < 45) {
    return { value: Math.round(diffSeconds / 60), unit: 'minute' };
  }
  if (absMinutes < 90) {
    return { value: past ? -1 : 1, unit: 'hour' };
  }
  const absHours = absMinutes / 60;
  if (absHours < 22) {
    return { value: Math.round(diffSeconds / 3600), unit: 'hour' };
  }
  if (absHours < 36) {
    return { value: past ? -1 : 1, unit: 'day' };
  }
  if (absHours / 24 < 7) {
    return { value: Math.round(diffSeconds / 86400), unit: 'day' };
  }
  return null;
}

export function createDateFormatter(options: DateFormatterOptions): DateFormatter {
  const dateFmt = new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    timeZone: options.timeZone,
  });
  const dateTimeFmt = new Intl.DateTimeFormat(options.locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: options.timeZone,
  });
  const relativeFmt = new Intl.RelativeTimeFormat(options.locale, {
    numeric: 'auto',
  });

  function formatRelative(input: DateInput, now?: Date): string {
    const date = toDate(input);
    const base = now ?? new Date();
    const diffSeconds = Math.round((date.getTime() - base.getTime()) / 1000);
    const bucket = relativeTimeBucket(diffSeconds);
    return bucket ? relativeFmt.format(bucket.value, bucket.unit) : dateFmt.format(date);
  }

  return {
    formatDate(input) {
      return dateFmt.format(toDate(input));
    },
    formatDateTime(input) {
      return dateTimeFmt.format(toDate(input));
    },
    formatRelative,
  };
}
