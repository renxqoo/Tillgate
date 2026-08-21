'use client';

import { useState } from 'react';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@ai-gateway/ui/components/ui/chart';
import { ToggleGroup, ToggleGroupItem } from '@ai-gateway/ui/components/ui/toggle-group';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import type { UsageByModelItem } from '@ai-gateway/api-client';
import { formatMoney } from '@ai-gateway/api-client/formatters';
import { useTranslations } from 'next-intl';

type Metric = 'cost' | 'tokens' | 'requests' | 'cacheRate';

interface MetricMeta {
  label: string;
  format: (v: number) => string;
}

/**
 * 不同模型使用量（横向条形图）。
 * 一次拉全量数据，前端用 ToggleGroup 切换度量（费用 / Token / 次数），无需重新请求。
 */
export function ModelUsageChart({ data }: { readonly data: ReadonlyArray<UsageByModelItem> }) {
  const t = useTranslations('dashboard');
  const [metric, setMetric] = useState<Metric>('cost');
  const METRICS: Record<Metric, MetricMeta> = {
    cost: { label: t('costLabel'), format: (v) => `¥${formatMoney(v)}` },
    tokens: { label: t('metricTokens'), format: (v) => v.toLocaleString('en-US') },
    requests: { label: t('metricRequests'), format: (v) => v.toLocaleString('en-US') },
    cacheRate: { label: t('metricCacheRate'), format: (v) => `${(v * 100).toFixed(2)}%` },
  };

  if (data.length === 0) {
    return (
      <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
        {t('noUsageData')}
      </div>
    );
  }

  const meta = METRICS[metric];
  const valueOf = (it: UsageByModelItem): number => {
    if (metric === 'cost') return Number(it.cost) || 0;
    if (metric === 'tokens') return it.inputTokens + it.outputTokens;
    // 缓存率 = 缓存命中 token / 输入 token（聚合后的总比例）
    if (metric === 'cacheRate')
      return it.inputTokens > 0 ? it.cachedInputTokens / it.inputTokens : 0;
    return it.requests;
  };
  // 按当前度量降序后取 Top 10，避免模型过多时条形挤压
  const chartData = data
    .map((it) => ({ model: it.model, value: valueOf(it) }))
    .toSorted((a, b) => b.value - a.value)
    .slice(0, 10);
  // 高度随模型数量伸缩：每个模型一行（44px），保证条形粗细一致而非被拉伸/压缩
  const chartHeight = Math.max(chartData.length * 44, 180);

  const chartConfig = {
    value: { label: meta.label, color: 'var(--chart-2)' },
  } satisfies ChartConfig;

  return (
    <div className="space-y-3">
      <ToggleGroup
        type="single"
        value={metric}
        onValueChange={(v) => {
          if (v) setMetric(v as Metric);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="cost">{t('metricCost')}</ToggleGroupItem>
        <ToggleGroupItem value="tokens">{t('metricTokens')}</ToggleGroupItem>
        <ToggleGroupItem value="requests">{t('metricRequests')}</ToggleGroupItem>
        <ToggleGroupItem value="cacheRate">{t('metricCacheRate')}</ToggleGroupItem>
      </ToggleGroup>
      <ChartContainer
        config={chartConfig}
        className="aspect-auto w-full"
        style={{ height: chartHeight }}
      >
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
        >
          <CartesianGrid horizontal={false} strokeOpacity={0.15} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v: number) => meta.format(v)}
          />
          <YAxis
            type="category"
            dataKey="model"
            tickLine={false}
            axisLine={false}
            width={150}
            tickMargin={8}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                formatter={(value) => meta.format(Number(value))}
              />
            }
          />
          <Bar dataKey="value" fill="var(--chart-2)" radius={4} barSize={28} />
        </BarChart>
      </ChartContainer>
    </div>
  );
}
