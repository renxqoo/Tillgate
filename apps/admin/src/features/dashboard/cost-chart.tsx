'use client';

import type { ChartConfig } from '@tillgate/ui';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@tillgate/ui';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { formatMoney } from '@/lib/formatters';

const tokensConfig: ChartConfig = {
  value: { label: 'Tokens', color: 'var(--chart-2)' },
};

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
