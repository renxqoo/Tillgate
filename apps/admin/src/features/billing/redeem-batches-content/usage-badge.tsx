'use client';

export function UsageBadge({ rate }: { rate: number }) {
  let color = 'text-muted-foreground';
  if (rate >= 80) color = 'text-emerald-600 dark:text-emerald-400';
  else if (rate >= 30) color = 'text-amber-600 dark:text-amber-400';
  return <span className={`text-xs font-medium tabular-nums ${color}`}>{rate}%</span>;
}
