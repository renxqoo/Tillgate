'use client';

import { useCallback } from 'react';

import { ChartTooltipContent } from '@tillgate/ui';

/** tooltip 行：数值格式化 + 系列名（模块级组件——不在渲染内重建） */
export function TrendTooltip(props: {
  indicator?: 'line' | 'dot' | 'dashed';
  formatValue: (v: number) => string;
}) {
  const { indicator = 'line', formatValue } = props;
  const render = useCallback(
    (value: unknown, name: unknown) => (
      <span className="font-mono text-tabular-nums">
        {formatValue(Number(value))}
        <span className="ml-2 text-muted-foreground">{String(name)}</span>
      </span>
    ),
    [formatValue],
  );
  return <ChartTooltipContent indicator={indicator} formatter={render} />;
}
