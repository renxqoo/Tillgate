/**
 * 分时段计价（schedule 策略）的纯函数语义（单一真相）：
 * 窗口形状、计费时区分钟匹配、环形命中、写入校验——策略解析（gateway 组装消费）
 * 与管理写入校验（control-plane 消费）共用。
 *
 * 口径（2026-08-24 拍板）：时间锚点 = 请求准入时刻；边界左闭右开（start ≤ t < end，
 * 分钟粒度）；end < start = 跨午夜环形窗口；未命中时段回落基价列（基价 = 峰时/缺省）。
 * 时区全系统统一（system_configs 注入装配面，域内只收 IANA 字符串）。
 */
import { Decimal } from '../money.js';
import type { PricingContext, PricingStrategy } from './pricing-strategy.js';

/** 时段窗口（billing_config.params.windows 数组元素；价格字段写哪个覆盖哪个，未写回落基价列） */
export interface PricingWindow {
  /** 审计/展示标签（收据 pricing_window 落此值；缺省 "start-end"） */
  label?: string;
  /** 起始 HH:MM（含） */
  start: string;
  /** 结束 HH:MM（不含；小于 start = 跨午夜） */
  end: string;
  inputPrice?: string;
  outputPrice?: string;
  cacheInputPrice?: string;
  cacheWritePrice?: string;
  unitPrice?: string;
}

/** 窗口覆盖的价格轴词表（写入校验与覆盖装配共用） */
const WINDOW_PRICE_FIELDS = [
  'inputPrice',
  'outputPrice',
  'cacheInputPrice',
  'cacheWritePrice',
  'unitPrice',
] as const;

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:MM" → 当日分钟数；不合法返回 null */
export function minuteOf(hhmm: string): number | null {
  const matched = HH_MM.exec(hhmm);
  if (matched == null) return null;
  return Number(matched[1]) * 60 + Number(matched[2]);
}

// Intl formatter 构造是热路径相对昂贵操作——按时区进程内缓存
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterOf(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone);
  if (formatter == null) {
    // 非法时区字符串在构造处抛 RangeError（fail-loud：时区配置事故不得静默错档计价）
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timezone, formatter);
  }
  return formatter;
}

/** 计费时区下的当日分钟数（墙钟口径；DST 时区自然跟随当地时间） */
export function minuteOfDayInZone(now: Date, timezone: string): number {
  const parts = formatterOf(timezone).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23) {
    throw new RangeError(`unexpected timezone parts for ${timezone}`);
  }
  return hour * 60 + minute;
}

/** 命中判定（左闭右开；start === end 零长度恒不命中——写入校验已拒，此处防御） */
export function windowContains(window: PricingWindow, minuteOfDay: number): boolean {
  const start = minuteOf(window.start);
  const end = minuteOf(window.end);
  if (start == null || end == null || start === end) return false;
  if (start < end) return minuteOfDay >= start && minuteOfDay < end;
  return minuteOfDay >= start || minuteOfDay < end; // 跨午夜环形
}

/** 按准入时刻命中窗口（未命中返回 null → 回落基价列） */
export function matchPricingWindow(
  windows: readonly PricingWindow[],
  now: Date,
  timezone: string,
): PricingWindow | null {
  const minuteOfDay = minuteOfDayInZone(now, timezone);
  for (const window of windows) {
    if (windowContains(window, minuteOfDay)) return window;
  }
  return null;
}

/** 窗口标签（收据审计列值；缺省 "start-end"） */
export function windowLabelOf(window: PricingWindow): string {
  const label = window.label?.trim();
  return label != null && label.length > 0 ? label : `${window.start}-${window.end}`;
}

/** 写入校验问题（机器可读 detail；价格数值域由调用方各自的金额解析把关） */
export type ScheduleWindowsIssue =
  | { field: 'windows.empty' }
  | { field: 'window.format'; index: number; value: string }
  | { field: 'window.empty'; index: number }
  | { field: 'window.no_price'; index: number }
  | { field: 'window.overlap'; index: number; other: number };

/**
 * 窗口表校验（写入路径单一真相）：HH:MM 格式、start ≠ end、每窗口至少一个价格字段、
 * 窗口两两不重叠（跨午夜展开到分钟占用位图）。价格数值合法性不在本函数——
 * control-plane/admin-api 用各自的非负金额解析补验。
 */
export function validateScheduleWindows(windows: PricingWindow[]): ScheduleWindowsIssue | null {
  if (windows.length === 0) return { field: 'windows.empty' };
  const owner = new Map<number, number>();
  for (const [index, window] of windows.entries()) {
    const start = minuteOf(window.start);
    const end = minuteOf(window.end);
    if (start == null) return { field: 'window.format', index, value: window.start };
    if (end == null) return { field: 'window.format', index, value: window.end };
    if (start === end) return { field: 'window.empty', index };
    const hasPrice = WINDOW_PRICE_FIELDS.some((field) => window[field] != null);
    if (!hasPrice) return { field: 'window.no_price', index };
    for (let minute = start; minute !== end; minute = (minute + 1) % 1440) {
      const existing = owner.get(minute);
      if (existing !== undefined) return { field: 'window.overlap', index, other: existing };
      owner.set(minute, index);
    }
  }
  return null;
}

/** 结算单价：命中窗口的 unitPrice，未命中/未配置回落基价列 */
function scheduleUnitPrice(context: PricingContext): string {
  const windows = context.config.params?.windows;
  if (windows == null || windows.length === 0) return context.fallbackUnitPrice;
  return (
    matchPricingWindow(windows, context.now, context.timezone)?.unitPrice ??
    context.fallbackUnitPrice
  );
}

/** 预扣单价（保守口径）：基价列与全部窗口 unitPrice 的最大值——准入时刻未定时的上界 */
function highestScheduleUnitPrice(context: PricingContext): string {
  let max = new Decimal(0);
  const candidates = [
    context.fallbackUnitPrice,
    ...(context.config.params?.windows ?? [])
      .map((window) => window.unitPrice)
      .filter((value): value is string => value != null),
  ];
  for (const candidate of candidates) {
    const decimal = new Decimal(candidate);
    if (decimal.gt(max)) max = decimal;
  }
  return max.toString();
}

/**
 * schedule 策略对象：按准入时刻 + 计费时区命中窗口，产出整套价格覆盖（字段级：
 * 未覆盖轴回落解析基价）与审计标签。estimate/settle 同刻解析（hold == settle 单一
 * 价格快照——预扣与实扣不因窗口边界分裂）。
 */
export const scheduleStrategy: PricingStrategy = {
  estimateUnitPrice: highestScheduleUnitPrice,
  settleUnitPrice: scheduleUnitPrice,
  resolvePriceOverrides: (context) => {
    const windows = context.config.params?.windows;
    if (windows == null || windows.length === 0) return null;
    const hit = matchPricingWindow(windows, context.now, context.timezone);
    if (hit == null) return null;
    return {
      ...(hit.inputPrice != null ? { inputPrice: hit.inputPrice } : {}),
      ...(hit.outputPrice != null ? { outputPrice: hit.outputPrice } : {}),
      ...(hit.cacheInputPrice != null ? { cacheInputPrice: hit.cacheInputPrice } : {}),
      ...(hit.cacheWritePrice != null ? { cacheWritePrice: hit.cacheWritePrice } : {}),
      ...(hit.unitPrice != null ? { unitPrice: hit.unitPrice } : {}),
      pricingWindow: windowLabelOf(hit),
    };
  },
};
