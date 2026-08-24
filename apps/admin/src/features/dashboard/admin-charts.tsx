'use client';

import type { ChartConfig } from '@tillgate/ui';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@tillgate/ui';
import { useTranslations } from 'next-intl';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { formatMoney } from '@/lib/formatters';

const tokensConfig: ChartConfig = {
  value: { label: 'Tokens', color: 'var(--chart-2)' },
};

export function RequestsChart({ data }: { data: ReadonlyArray<{ date: string; value: number }> }) {
  const t = useTranslations('dashboard');
  // tooltip 名称走目录（模块级常量无法按 locale 解析）
  const requestsConfig: ChartConfig = {
    value: { label: t('requestsLabel'), color: 'var(--chart-1)' },
  };
  return (
    <ChartContainer config={requestsConfig} className="aspect-auto h-62.5 w-full">
      <AreaChart
        data={data as Array<{ date: string; value: number }>}
        margin={{ left: 12, right: 12, top: 4, bottom: 4 }}
      >
        <defs>
          <linearGradient id="req-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => v.slice(5)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`}
          width={42}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-1)"
          fill="url(#req-fill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}

export function CostChart({ data }: { data: ReadonlyArray<{ date: string; value: number }> }) {
  return (
    <ChartContainer config={tokensConfig} className="aspect-auto h-62.5 w-full">
      <BarChart
        data={data as Array<{ date: string; value: number }>}
        margin={{ left: 12, right: 12, top: 4, bottom: 4 }}
      >
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          tickFormatter={(v) => v.slice(5)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `¥${formatMoney(v)}`}
          width={64}
        />
        <ChartTooltip
          cursor={false}
          content={
            <ChartTooltipContent
              indicator="line"
              hideLabel
              formatter={(value) => `¥${formatMoney(Number(value))}`}
            />
          }
        />
        <Bar dataKey="value" fill="var(--chart-2)" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
