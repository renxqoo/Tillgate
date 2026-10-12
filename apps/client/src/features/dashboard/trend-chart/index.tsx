'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { Button, ChartContainer, ChartTooltip, type ChartConfig } from '@tillgate/ui';
import type { UsageTrendRow } from '@tillgate/api-client';

import { loadHourlyTrendAction } from '@/server/actions/usage';
import { formatMoney } from '@/features/shared/format';
import {
  TREND_WINDOW_DAYS,
  compactCount,
  fillDailyTrendSeries,
  fillHourlyTrendSeries,
} from '@/features/dashboard/trend-series';
import { TrendToggle } from './trend-toggle';
import { TrendTooltip } from './trend-tooltip';

/** 粒度切换（day = 近 14 天日桶；hour = 今日 24 小时桶） */
type Granularity = 'day' | 'hour';
/** 度量切换（cost/requests 单系列；tokens = 输入/输出/缓存三分系列） */
type Measure = 'cost' | 'tokens' | 'requests';
/** 堆叠系列的数据键尾缀（tokens 度量三键并存，其余单键） */
type SeriesMetric = 'cost' | 'input' | 'output' | 'cached' | 'requests';

/** 图表系列色板（recharts var；色索引 = 当前序列模型首现序——度量切换间同模型同色；跨粒度首现序可能不同，不承诺同色） */
const SERIES_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
] as const;

const METRIC_KEYS: Record<Measure, readonly SeriesMetric[]> = {
  cost: ['cost'],
  tokens: ['input', 'output', 'cached'],
  requests: ['requests'],
};

/** 图例模型上限：tokens 度量 = 模型 × 3 系列，不设限会挤爆图例与色板 */
const LEGEND_MAX_MODELS = 8;

function seriesColor(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length] ?? 'var(--chart-1)';
}

/**
 * 模型 × 度量展开的系列清单（顺序 = 堆叠顺序；colorIndex = 模型序——度量
 * 切换间同模型同色；跨粒度不承诺）。seriesKey 供 values 取数与 ChartConfig 索引
 * （不进字符串 dataKey 深路径——模型名含 `.` 时 recharts 深路径解析为 0）。
 */
function buildSeries(models: readonly string[], metrics: readonly SeriesMetric[]) {
  const keys: Array<{ key: string; model: string; metric: SeriesMetric; colorIndex: number }> = [];
  models.forEach((model, i) => {
    for (const metric of metrics) {
      keys.push({ key: `${model}::${metric}`, model, metric, colorIndex: i });
    }
  });
  return keys;
}

interface TrendChartProps {
  /** day 粒度趋势行（服务端预取） */
  dayRows: ReadonlyArray<UsageTrendRow>;
  /** 序列时区（DISPLAY_TZ；与服务端桶口径同源） */
  timeZone: string;
  /** now 服务端取一次传入（SSR/水合同一时钟，消除午夜/钟差边界的水合不一致） */
  now: Date;
}

/**
 * 用量趋势图：粒度（日/小时）× 度量（费用/Token/请求）双切换，系列按模型堆叠。
 * Token 度量下输入/输出/缓存三系列分列（每模型 × 三系列）。
 * ToggleGroup 常驻（加载/失败态不吞掉切换件——失败可切回 day 或重试）。
 */
// eslint-disable-next-line max-lines-per-function -- 图表编排：系列推导/懒加载/双 ToggleGroup/三态渲染平铺，行数来自 JSX 声明
export function TrendChart({ dayRows, timeZone, now }: TrendChartProps) {
  const t = useTranslations('dashboard');
  const locale = useLocale();
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [measure, setMeasure] = useState<Measure>('cost');
  const [hourly, setHourly] = useState<ReadonlyArray<UsageTrendRow> | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // 切到 hour 且无数据时懒加载（server action 直调——server reference 可过 RSC 序列化）
  // 依赖含 loadFailed：Retry 清失败标志后依赖变化重拉（失败态 hourly 仍 null）
  useEffect(() => {
    if (granularity !== 'hour' || hourly != null || loadFailed) return;
    let cancelled = false;
    loadHourlyTrendAction()
      .then((rows) => {
        if (cancelled) return null;
        if (rows == null) setLoadFailed(true);
        else setHourly(rows);
        return null;
      })
      .catch(() => {
        // server action 网络层异常同失败态（action 自身 catch 已归一 null，此处兜底）
        if (!cancelled) setLoadFailed(true);
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, [granularity, hourly, loadFailed]);

  const series = useMemo(() => {
    if (granularity === 'hour') {
      return fillHourlyTrendSeries({ rows: hourly ?? [], timeZone, now });
    }
    return fillDailyTrendSeries({ rows: dayRows, days: TREND_WINDOW_DAYS, timeZone, now });
  }, [granularity, hourly, dayRows, timeZone, now]);

  const metricKeys = METRIC_KEYS[measure];
  const seriesKeys = useMemo(() => buildSeries(series.models, metricKeys), [series, metricKeys]);

  // tooltip 用全值（分组数千位）；Y 轴刻度用紧凑单位（K/M/B——长数字会溢出轴宽遮挡）
  const formatValue = useCallback(
    (v: number) => (measure === 'cost' ? formatMoney(v, locale) : v.toLocaleString('en-US')),
    [measure, locale],
  );
  const formatTick = useCallback(
    (v: number) => (measure === 'cost' ? formatMoney(v, locale) : compactCount(v)),
    [measure, locale],
  );

  const chartConfig = useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    seriesKeys.forEach(({ key, model, metric, colorIndex }) => {
      const metricLabel =
        metric === 'input'
          ? t('metricInput')
          : metric === 'output'
            ? t('metricOutput')
            : metric === 'cached'
              ? t('metricCached')
              : metric === 'requests'
                ? t('metricRequests')
                : t('costLabel');
      // 模型 · 度量构成可分辨的系列名（Token 度量三系列同名模型可分）
      config[key] = { label: `${model} · ${metricLabel}`, color: seriesColor(colorIndex) };
    });
    return config satisfies ChartConfig;
  }, [seriesKeys, t]);

  const hasAnyData = series.points.some((p) => Object.values(p.values).some((v) => v > 0));

  // 图例按模型截断（Top-N 保序）；系列渲染不受截断影响（数据完整）
  const legendModels = series.models.slice(0, LEGEND_MAX_MODELS);
  const hourLoading = granularity === 'hour' && hourly == null && !loadFailed;

  const granularityOptions = [
    { value: 'day' as const, label: t('granularityDay') },
    { value: 'hour' as const, label: t('granularityHour') },
  ];
  const measureOptions = [
    { value: 'cost' as const, label: t('metricCost') },
    { value: 'tokens' as const, label: t('metricTokens') },
    { value: 'requests' as const, label: t('metricRequests') },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <TrendToggle value={granularity} options={granularityOptions} onChange={setGranularity} />
        <TrendToggle value={measure} options={measureOptions} onChange={setMeasure} />
      </div>
      {hourLoading ? (
        <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
          {t('loading')}
        </div>
      ) : loadFailed && granularity === 'hour' ? (
        <div className="flex h-62.5 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <span>{t('hourlyLoadFailed')}</span>
          {/* 重试：清失败态（effect 依赖变化重新拉取；也可直接切回 day） */}
          <Button variant="outline" size="sm" onClick={() => setLoadFailed(false)}>
            {t('retry')}
          </Button>
        </div>
      ) : !hasAnyData ? (
        <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
          {t('noUsageData')}
        </div>
      ) : (
        <ChartContainer config={chartConfig} className="aspect-auto h-62.5 w-full">
          <AreaChart data={series.points} margin={{ left: 12, right: 12, top: 4, bottom: 4 }}>
            <defs>
              {/* 色索引 id：模型名归一会碰撞（a.b/a_b 同 id）——序号保证唯一；
                  tokens 度量同模型三系列同色 → 按 colorIndex 去重（每 id 只定义一次） */}
              {[...new Set(seriesKeys.map((sk) => sk.colorIndex))].map((colorIndex) => (
                <linearGradient
                  key={colorIndex}
                  id={`trend-grad-${colorIndex}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={seriesColor(colorIndex)} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={seriesColor(colorIndex)} stopOpacity={0.03} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} strokeOpacity={0.15} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v: string) => (granularity === 'hour' ? v.slice(11, 13) : v.slice(5))}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => formatTick(v)}
              width={56}
            />
            <ChartTooltip
              cursor={false}
              content={<TrendTooltip indicator="line" formatValue={formatValue} />}
            />
            {seriesKeys.map(({ key, colorIndex }) => (
              <Area
                key={key}
                type="monotone"
                /* 函数 dataKey：模型名含 `.` 时字符串深路径被 recharts 切 path 解析为 0 */
                dataKey={(d: (typeof series.points)[number]) => d.values[key] ?? 0}
                name={chartConfig[key]?.label}
                stackId="trend"
                stroke={seriesColor(colorIndex)}
                fill={`url(#trend-grad-${colorIndex})`}
                strokeWidth={1.5}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      )}
      {/* 自绘图例：模型 × 色块（Top-N；ChartLegend 组合在此 recharts 版本不渲染 series，故不依赖） */}
      {hasAnyData ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {legendModels.map((model, i) => (
            <span key={model} className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: seriesColor(i) }}
              />
              {model}
            </span>
          ))}
        </div>
      ) : null}
      {/* 模型数超图例上限的提示（数据不截断，仅图例展示受限） */}
      {series.models.length > LEGEND_MAX_MODELS && !hourLoading ? (
        <p className="text-xs text-muted-foreground">
          {t('legendMoreModels', { count: series.models.length - LEGEND_MAX_MODELS })}
        </p>
      ) : null}
    </div>
  );
}
