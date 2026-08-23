// KPI 指标卡: 纯展示, 数值/文案由调用方格式化后注入;
// delta 显式声明涨跌方向与业务好坏(sentiment), 不假设"涨=好"
import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../../cn';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../primitives/card';
import { Skeleton } from '../primitives/skeleton';

export type KpiCardDelta = {
  trend: 'up' | 'down' | 'flat';
  sentiment: 'positive' | 'negative' | 'neutral';
  text: React.ReactNode;
};

export type KpiCardProps = {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: KpiCardDelta;
  hint?: React.ReactNode;
  loading?: boolean;
  className?: string;
};

const TREND_ICONS = {
  up: TrendingUpIcon,
  down: TrendingDownIcon,
  flat: MinusIcon,
} as const;

function sentimentClass(sentiment: KpiCardDelta['sentiment']): string {
  if (sentiment === 'positive') {
    return 'text-success';
  }
  return sentiment === 'negative' ? 'text-destructive' : 'text-muted-foreground';
}

export function KpiCard({ label, value, delta, hint, loading = false, className }: KpiCardProps) {
  const TrendIcon = delta ? TREND_ICONS[delta.trend] : null;

  return (
    <Card data-slot="kpi-card" className={cn('gap-2', className)}>
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl font-medium tabular-nums">
          {loading ? <Skeleton className="h-7 w-24" /> : value}
        </CardTitle>
      </CardHeader>
      {delta || hint ? (
        <CardContent className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {delta && TrendIcon ? (
            <span
              data-slot="kpi-card-delta"
              data-sentiment={delta.sentiment}
              className={cn(
                'inline-flex items-center gap-1 font-medium',
                sentimentClass(delta.sentiment),
              )}
            >
              <TrendIcon className="size-3.5" />
              {delta.text}
            </span>
          ) : null}
          {hint ? (
            <span className="text-muted-foreground" data-slot="kpi-card-hint">
              {hint}
            </span>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
