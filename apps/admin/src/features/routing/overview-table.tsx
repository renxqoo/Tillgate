'use client';

/**
 * 渠道观测表（哑件：行渲染；文案经 t 注入）。状态图标 lucide + i18n 标签
 * （title 提示本地化——0 启用/1 禁用/2 维护/3 熔断/4 凭据无效，与 channels
 * 表 status 语义一一对应）。
 */
import { CheckCircle2, KeyRound, PauseCircle, ShieldAlert, Wrench } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ChannelOverviewView } from './routing-content-types';

/** 毫秒 → 带单位短文案（<1s 也带 ms 后缀——不与秒混排；非有限值 '-'） */
const fmtMs = (v: number): string =>
  Number.isFinite(v) ? (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${v}ms`) : '-';
/** 渠道五态渲染定义（图标 + i18n 键；越界兜底禁用态） */
const STATUS_CELLS: ReadonlyArray<{
  icon: ComponentType<{ className?: string }>;
  key: string;
}> = [
  { icon: CheckCircle2, key: 'statusEnabled' },
  { icon: PauseCircle, key: 'statusDisabled' },
  { icon: Wrench, key: 'statusMaintenance' },
  { icon: ShieldAlert, key: 'statusCircuitBroken' },
  { icon: KeyRound, key: 'statusInvalidCredential' },
];
const STATUS_FALLBACK = { icon: PauseCircle, key: 'statusDisabled' };
/** 金额快照（numeric 字符串——非有限值显示 '-'，不渲染 NaN） */
const fmtAmount = (v: string): string => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '-';
};

export function ChannelOverviewTable({
  rows,
  t,
}: {
  rows: ChannelOverviewView[];
  t: (k: string) => string;
}) {
  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 font-semibold">{t('overviewTitle')}</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground border-b text-left text-xs">
              <th className="py-2">{t('channel')}</th>
              <th>{t('status')}</th>
              <th>{t('priority')}</th>
              <th>{t('budget')}</th>
              <th>{t('requests')}</th>
              <th>{t('failRate')}</th>
              <th>{t('ttft')}</th>
              <th>{t('cacheHit')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-muted-foreground py-6 text-center">
                  {t('noData')}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const cacheHit =
                  row.inputTokens > 0
                    ? Math.round((row.cachedInputTokens / row.inputTokens) * 100)
                    : 0;
                const cell = STATUS_CELLS[row.status] ?? STATUS_FALLBACK;
                const StatusIcon = cell.icon;
                return (
                  <tr key={row.channelId} className="border-b last:border-0">
                    <td className="py-2 font-medium">{row.channelName}</td>
                    <td title={t(cell.key)}>
                      <StatusIcon className="h-4 w-4" aria-label={t(cell.key)} />
                    </td>
                    <td>{row.priority ?? '-'}</td>
                    <td className="tabular-nums">
                      {fmtAmount(row.upstreamRemaining)} / {fmtAmount(row.upstreamBudget)}
                    </td>
                    <td className="tabular-nums">{row.requests}</td>
                    <td className="tabular-nums">
                      {row.requests > 0
                        ? `${Math.round((row.failures / row.requests) * 100)}%`
                        : '-'}
                    </td>
                    <td className="tabular-nums">
                      {row.avgClientTtftMs != null ? fmtMs(row.avgClientTtftMs) : '-'}
                    </td>
                    <td className="tabular-nums">{cacheHit > 0 ? `${cacheHit}%` : '-'}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
