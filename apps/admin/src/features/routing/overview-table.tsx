/**
 * 渠道观测表（服务端哑件：数据已按 sort 排序、已按窗口取回，组件只渲染）。
 *
 * 口径契约：
 *   - 预算比例/失败率只取自 overview-sort 的 budgetRatioOf/failRateOf（与排序、
 *     budgetWatermark scorer 同源），组件内不重算比例；
 *   - 预算列高亮是 scorer 同源事实的投影：比例低于降权阈值 = 正在被降权（warning）；
 *     比例 ≤ 0 = 剩余耗尽（destructive——硬事实，不随阈值开关消失）；
 *   - 失败率着色阈值是展示层约定（FAIL_RATE_* 常量），不是业务规则。
 */
import { DataTable, type DataTableColumn } from '@/components/data-table';
import { formatMoney, fmtInt, msToHuman } from '@/lib/formatters';
import type { SearchParamsInput } from '@/lib/list-query';
import { cn } from '@/lib/utils';
import { StatusPill } from '@tillgate/ui';
import { budgetRatioOf, failRateOf } from './overview-sort';
import { OverviewWindowToggle } from './overview-window-toggle';
import type { BudgetWatermarkHint, ChannelOverviewView } from './routing-content-types';

/** 失败率着色阈值（展示层约定）：≥10% 危险、≥5% 预警、低于 5% 正常前景色 */
const FAIL_RATE_WARN = 0.05;
const FAIL_RATE_CRITICAL = 0.1;

/** 渠道五态 → StatusPill 语义色 + i18n 键（0 启用/1 禁用/2 维护/3 熔断/4 凭据无效；
 * 越界兜底 neutral + 禁用文案——不可读状态按坏消息处理） */
const STATUS_PILLS = [
  { tone: 'success', key: 'statusEnabled' },
  { tone: 'neutral', key: 'statusDisabled' },
  { tone: 'warning', key: 'statusMaintenance' },
  { tone: 'destructive', key: 'statusCircuitBroken' },
  { tone: 'destructive', key: 'statusInvalidCredential' },
] as const;
const STATUS_PILL_FALLBACK = { tone: 'neutral', key: 'statusDisabled' } as const;

/** 列定义（t/watermark 经参数传入；比例派生统一走 overview-sort，保持单一真相） */
function buildOverviewColumns(
  t: (k: string) => string,
  watermark: BudgetWatermarkHint,
): DataTableColumn<ChannelOverviewView>[] {
  return [
    {
      key: 'channel',
      header: t('channel'),
      sortable: true,
      render: (row) => <span className="font-medium">{row.channelName}</span>,
    },
    {
      key: 'status',
      header: t('status'),
      render: (row) => {
        const pill = STATUS_PILLS[row.status] ?? STATUS_PILL_FALLBACK;
        return <StatusPill tone={pill.tone}>{t(pill.key)}</StatusPill>;
      },
    },
    {
      key: 'priority',
      header: t('priority'),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => row.priority ?? '—',
    },
    {
      key: 'weight',
      header: t('weight'),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => fmtInt(row.weight),
    },
    {
      key: 'budget',
      header: t('budget'),
      sortable: true,
      sortBy: 'budgetRatio',
      align: 'right',
      className: 'tabular-nums',
      render: (row) => {
        const ratio = budgetRatioOf(row);
        if (ratio == null) return '—';
        // 与 budgetWatermark scorer 同源：低于阈值 = 正在被降权；≤0 = 剩余耗尽
        //（耗尽优先于降权预警，且不随阈值开关消失）
        const depleted = ratio <= 0;
        const downweighted = watermark.enabled && ratio < watermark.softRatio;
        return (
          <span className="inline-flex flex-col items-end gap-0.5">
            <span
              className={cn(
                depleted
                  ? 'font-medium text-destructive'
                  : downweighted
                    ? 'font-medium text-warning'
                    : undefined,
              )}
            >
              {Math.round(ratio * 100)}%
            </span>
            <span className="text-muted-foreground text-xs">
              {formatMoney(row.upstreamRemaining)} / {formatMoney(row.upstreamBudget)}
            </span>
          </span>
        );
      },
    },
    {
      key: 'requests',
      header: t('requests'),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => fmtInt(row.requests),
    },
    {
      key: 'failRate',
      header: t('failRate'),
      sortable: true,
      sortBy: 'failRate',
      align: 'right',
      className: 'tabular-nums',
      render: (row) => {
        const rate = failRateOf(row);
        if (rate == null) return '—';
        // 展示层阈值约定（非业务规则）：≥10% 危险、≥5% 预警、<5% 正常前景色
        const tone =
          rate >= FAIL_RATE_CRITICAL
            ? 'font-medium text-destructive'
            : rate >= FAIL_RATE_WARN
              ? 'font-medium text-warning'
              : undefined;
        return (
          <span className="inline-flex items-baseline justify-end gap-1.5">
            <span className={tone}>{Math.round(rate * 100)}%</span>
            <span className="text-muted-foreground text-xs">
              {fmtInt(row.failures)}/{fmtInt(row.requests)}
            </span>
          </span>
        );
      },
    },
    {
      key: 'avgClientTtftMs',
      header: t('ttft'),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => (row.avgClientTtftMs != null ? msToHuman(row.avgClientTtftMs) : '—'),
    },
    {
      key: 'avgDurationMs',
      header: t('avgDuration'),
      sortable: true,
      align: 'right',
      className: 'tabular-nums',
      render: (row) => (row.avgDurationMs != null ? msToHuman(row.avgDurationMs) : '—'),
    },
    {
      key: 'cacheHit',
      header: t('cacheHit'),
      align: 'right',
      className: 'tabular-nums',
      // inputTokens > 0 恒显示（含 0%——0% 命中与无输入样本是两回事）
      render: (row) =>
        row.inputTokens > 0
          ? `${Math.round((row.cachedInputTokens / row.inputTokens) * 100)}%`
          : '—',
    },
  ];
}

export function ChannelOverviewTable({
  rows,
  t,
  searchParams,
  sort,
  windowHours,
  watermark,
}: {
  rows: ChannelOverviewView[];
  t: (k: string) => string;
  /** 当前页完整 query（排序链接保留 window 等其余参数） */
  searchParams?: SearchParamsInput;
  /** 当前排序态（页面层已应用；表头高亮 + 排序链接消费） */
  sort?: { sortBy: string; order: 'asc' | 'desc' };
  /** 观测窗口（数据已按窗口取回；标题行右侧切换入口） */
  windowHours: 1 | 24;
  /** 预算降权阈值快照（预算列高亮依据；enabled=false 不做阈值高亮） */
  watermark: BudgetWatermarkHint;
}) {
  const columns = buildOverviewColumns(t, watermark);
  return (
    <section className="rounded-lg border p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{t('overviewTitle')}</h2>
        <OverviewWindowToggle windowHours={windowHours} />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.channelId}
        sort={sort}
        searchParams={searchParams}
        empty={t('noData')}
        // 区块自带 p-4：抵消 DataTable 首末单元格内建边距（first:pl-4/last:pr-4），与标题对齐
        className="[&_th:first-child]:pl-0 [&_td:first-child]:pl-0 [&_th:last-child]:pr-0 [&_td:last-child]:pr-0"
      />
    </section>
  );
}
