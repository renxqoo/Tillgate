import type { ReactNode } from "react";

import { Card, CardDescription, CardHeader, CardTitle } from "./ui/card";

/**
 * 仪表盘 KPI 卡片（admin / client dashboard 各一份合并，prop 统一 ReactNode）。
 */
export function KpiCard({
  icon,
  title,
  value,
  sub,
  hint,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  sub?: ReactNode;
  hint?: ReactNode;
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
        {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
}
