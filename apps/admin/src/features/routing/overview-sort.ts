/**
 * 渠道观测表的排序与派生指标（纯函数，页面层消费——排序走 URL，服务端排序后渲染）。
 *
 * 比例指标与后端口径对齐：
 *   - budgetRatio = remaining / budget（与 budgetWatermark scorer 的
 *     budgetWatermarkFactor 同算式：channel-store 与 routing-overview 的
 *     upstreamRemaining 均为 budget - reserved——展示即 scorer 输入）；
 *   - failRate = failures / requests（billing_requests 生命周期口径）。
 * null 语义：budget 无效（≤0/非数）或无请求样本——排序恒沉底、展示渲染占位符。
 */
import type { ChannelOverviewView } from './routing-content-types';

/** 允许出现在 URL sort_by 里的字段白名单（防任意字段比较） */
const OVERVIEW_SORT_FIELDS: ReadonlySet<string> = new Set([
  'channel',
  'priority',
  'weight',
  'requests',
  'failRate',
  'budgetRatio',
  'avgClientTtftMs',
  'avgDurationMs',
]);

export interface OverviewSortState {
  sortBy: string;
  order: 'asc' | 'desc';
}

/** 缺省排序：近窗请求数降序（流量优先——原 API 序 channels.id 降序对运维无意义） */
export const DEFAULT_OVERVIEW_SORT: OverviewSortState = { sortBy: 'requests', order: 'desc' };

/** URL 原始值 → 合法排序态（白名单外回落缺省；order 仅认 asc，其余为 desc） */
export function resolveOverviewSort(
  sortBy: string | undefined,
  order: string | undefined,
): OverviewSortState {
  if (sortBy != null && OVERVIEW_SORT_FIELDS.has(sortBy)) {
    return { sortBy, order: order === 'asc' ? 'asc' : 'desc' };
  }
  return DEFAULT_OVERVIEW_SORT;
}

/** 剩余/预算比例（null = 预算无效：≤0 或非数值——与 scorer 短路条件一致） */
export function budgetRatioOf(row: ChannelOverviewView): number | null {
  const budget = Number(row.upstreamBudget);
  const remaining = Number(row.upstreamRemaining);
  if (!Number.isFinite(budget) || !Number.isFinite(remaining) || budget <= 0) return null;
  return remaining / budget;
}

/** 失败率（null = 窗口内无请求样本——不显示 0% 误导） */
export function failRateOf(row: ChannelOverviewView): number | null {
  return row.requests > 0 ? row.failures / row.requests : null;
}

/** 全列共用的最终 tiebreak：同值时按 channelId 升序，排序结果稳定可复现 */
function byChannelId(a: ChannelOverviewView, b: ChannelOverviewView): number {
  return a.channelId - b.channelId;
}

/** 数值列比较子：null 恒沉底（与方向无关——延迟列的「无样本」不该因倒序跑到顶） */
function compareNullableNumbers(a: number | null, b: number | null, direction: number): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (a - b) * direction;
}

/** 数值排序字段提取（'channel' 走字符串比较，不在此列） */
function numericFieldOf(field: string, row: ChannelOverviewView): number | null {
  switch (field) {
    case 'priority':
      return row.priority;
    case 'weight':
      return row.weight;
    case 'failRate':
      return failRateOf(row);
    case 'budgetRatio':
      return budgetRatioOf(row);
    case 'avgClientTtftMs':
      return row.avgClientTtftMs;
    case 'avgDurationMs':
      return row.avgDurationMs;
    case 'requests':
    default:
      return row.requests;
  }
}

export function sortOverviewRows(
  rows: readonly ChannelOverviewView[],
  state: OverviewSortState,
): ChannelOverviewView[] {
  const direction = state.order === 'asc' ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const compared =
      state.sortBy === 'channel'
        ? a.channelName.localeCompare(b.channelName) * direction
        : compareNullableNumbers(
            numericFieldOf(state.sortBy, a),
            numericFieldOf(state.sortBy, b),
            direction,
          );
    return compared || byChannelId(a, b);
  });
  return sorted;
}
