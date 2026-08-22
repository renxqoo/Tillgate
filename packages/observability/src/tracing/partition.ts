/**
 * trace_spans 分区的纯日期助手与维护词表。
 * DDL 归 adapters/postgres/trace-partitions(UTC 天边界,全链路统一时区)。
 */

/** Date → 'YYYY-MM-DD'(UTC);分区边界统一用 UTC,杜绝会话时区错位 */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** UTC 日位移(保持 'YYYY-MM-DD' 形状) */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return dayKey(d);
}

export const TRACE_PARTITION_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface MaintainPartitionsOptions {
  /** 保留天数(分区日 < 今天-retention 才删);缺省 7 */
  retentionDays?: number;
  /** 预建未来天数;缺省 2 */
  lookaheadDays?: number;
}

export interface MaintainPartitionsResult {
  created: string[];
  dropped: string[];
}
