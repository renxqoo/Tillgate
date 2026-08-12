"use client";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@ai-gateway/ui/components/ui/chart";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

const requestsConfig: ChartConfig = {
  value: { label: "请求数", color: "var(--chart-1)" },
};

const tokensConfig: ChartConfig = {
  value: { label: "Tokens", color: "var(--chart-2)" },
};

export function RequestsChart({ data }: { data: ReadonlyArray<{ date: string; value: number }> }) {
  return (
    <ChartContainer config={requestsConfig} className="aspect-auto h-62.5 w-full">
      <AreaChart data={data as Array<{ date: string; value: number }>} margin={{ left: 12, right: 12, top: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="req-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.4} />
            <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => v.slice(5)} />
        <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => `${(v / 1000).toFixed(1)}k`} width={42} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
        <Area type="monotone" dataKey="value" stroke="var(--chart-1)" fill="url(#req-fill)" strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}

export function CostChart({ data }: { data: ReadonlyArray<{ date: string; value: number }> }) {
  return (
    <ChartContainer config={tokensConfig} className="aspect-auto h-62.5 ">3232
      <BarChart data={data as Array<{ date: string; value: number }>} margin={{ left: 12, right: 12, top: 4, bottom: 4 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.15} />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => v.slice(5)} />
        <YAxis tickLine={false} axisLine={false} tickFormatter={(v) => `¥${v}`} width={48} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" hideLabel />} />
        <Bar dataKey="value" fill="var(--chart-2)" radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}
