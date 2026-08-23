// 金额展示: format 函数必须由调用方注入(formatting/money 工厂产物), 组件不创建 formatter;
// tone="auto" 时按符号着色(正=success / 负=destructive / 零=前景色)
import { cn } from '../../cn';

export type MoneyDisplayProps = React.ComponentProps<'span'> & {
  amount: number;
  format: (amount: number) => string;
  tone?: 'auto' | 'none';
};

function toneClassFor(amount: number): string | undefined {
  if (amount > 0) {
    return 'text-success';
  }
  return amount < 0 ? 'text-destructive' : 'text-foreground';
}

export function MoneyDisplay({
  amount,
  format,
  tone = 'auto',
  className,
  ...props
}: MoneyDisplayProps) {
  return (
    <span
      data-slot="money-display"
      data-tone={tone}
      className={cn(
        'font-mono text-sm tabular-nums',
        tone === 'auto' ? toneClassFor(amount) : undefined,
        className,
      )}
      {...props}
    >
      {format(amount)}
    </span>
  );
}
