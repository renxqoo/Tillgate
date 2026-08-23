'use client';

import { Card, CardDescription, CardHeader, CardTitle } from '@tokenlens/ui';

/** 概览页指标卡（app 业务装配：icon + 主值 + 两行辅注；ui KpiCard 无 icon 位） */
export function KpiCard({
  icon,
  title,
  value,
  sub,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub?: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <CardDescription className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-md bg-muted text-foreground">
            {icon}
          </span>
          {title}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums tracking-tight">{value}</CardTitle>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardHeader>
    </Card>
  );
}
