"use client";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@ai-gateway/ui/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

const chartConfig: ChartConfig = {
  cost: { label: "费用（元）", color: "var(--chart-1)" },
};

export function CostChart({ data }: { data: ReadonlyArray<{ date: string; value: number }> }) {
  if (data.length === 0) {
    return (
      <div className="flex h-62.5 items-center justify-center text-sm text-muted-foreground">
        暂无用量数据
      </div>
    );
  }
  return (
    <ChartContainer config={chartConfig} className="aspect-auto h-62.5 w-full">
      <AreaChart data={data as Array<{ date: string; value: number }>} margin={{ left: 12, right: 12, top: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="cost-fill" x1="0" y1="0" x2="0" y2="1">
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
          tickFormatter={(v: string) => v.slice(5)}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickFormatter={(v: number) => v.toFixed(2)}
          width={48}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--chart-1)"
          fill="url(#cost-fill)"
          strokeWidth={2}
        />
      </AreaChart>
    </ChartContainer>
  );
}
