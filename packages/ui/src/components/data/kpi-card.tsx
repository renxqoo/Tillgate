// KPI 指标卡: 纯展示, 数值/文案由调用方格式化后注入;
// delta 显式声明涨跌方向与业务好坏(sentiment), 不假设"涨=好"
import { MinusIcon, TrendingDownIcon, TrendingUpIcon } from 'lucide-react';
import type * as React from 'react';

import { cn } from '../../cn';
import { Badge } from '../primitives/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../primitives/card';
import { Skeleton } from '../primitives/skeleton';

export interface KpiCardDelta {
  trend: 'up' | 'down' | 'flat';
  sentiment: 'positive' | 'negative' | 'neutral';
  text: React.ReactNode;
}

export interface KpiCardProps {
  label: React.ReactNode;
  value: React.ReactNode;
  icon?: React.ReactNode;
  sub?: React.ReactNode;
  delta?: KpiCardDelta;
  hint?: React.ReactNode;
  loading?: boolean;
  className?: string;
}

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

export function KpiCard({
  label,
  value,
  icon,
  sub,
  delta,
  hint,
  loading = false,
  className,
}: KpiCardProps) {
  const TrendIcon = delta ? TREND_ICONS[delta.trend] : null;

  return (
    <Card
      data-slot="kpi-card"
      className={cn(
        '@container/card gap-2 bg-muted/35 shadow-none ring-1 ring-border/60 dark:bg-muted/20',
        className,
      )}
    >
      <CardHeader>
        <CardDescription className="flex items-center gap-2">
          {icon ? (
            <span className="flex size-7 items-center justify-center rounded-lg bg-background/80 text-foreground [&_svg]:size-4">
              {icon}
            </span>
          ) : null}
          {label}
        </CardDescription>
        <CardTitle className="text-2xl font-semibold tabular-nums tracking-tight @[250px]/card:text-3xl">
          {loading ? <Skeleton className="h-7 w-24" /> : value}
        </CardTitle>
        {delta && TrendIcon ? (
          <CardAction>
            <Badge
              variant="outline"
              data-slot="kpi-card-delta"
              data-sentiment={delta.sentiment}
              className={cn('tabular-nums', sentimentClass(delta.sentiment))}
            >
              <TrendIcon />
              {delta.text}
            </Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      {sub || hint ? (
        <CardContent className="flex flex-col gap-1 text-xs">
          {sub ? <span className="font-medium text-foreground">{sub}</span> : null}
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
