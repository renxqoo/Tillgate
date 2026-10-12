'use client';

import { useCallback } from 'react';

import { ChartTooltipContent } from '@tillgate/ui';

/**
 * tooltip 行：数值格式化 + 系列名（模块级组件——不在渲染内重建）。
 * 必须透传 recharts 经 cloneElement 注入的 active/payload/label 等 props
 * （只解构 indicator/formatValue 时 ChartTooltipContent 拿不到 active，
 * 恒 return null——tooltip 永不显示）。
 */
export function TrendTooltip(props: {
  indicator?: 'line' | 'dot' | 'dashed';
  formatValue: (v: number) => string;
  /** recharts 注入的 active/payload/label 等——原样透传给内容组件 */
  [key: string]: unknown;
}) {
  const { indicator = 'line', formatValue, ...rest } = props;
  const render = useCallback(
    (value: unknown, name: unknown) => (
      <span className="font-mono text-tabular-nums">
        {formatValue(Number(value))}
        <span className="ml-2 text-muted-foreground">{String(name)}</span>
      </span>
    ),
    [formatValue],
  );
  return <ChartTooltipContent indicator={indicator} formatter={render} {...rest} />;
}
