// 状态胶囊: 语义色调(neutral/info/success/warning/destructive)由调用方从业务状态映射,
// 本组件不内置"业务状态 → 颜色"词表
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../cn';

const statusPillVariants = cva(
  'inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-4xl px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-muted text-muted-foreground',
        info: 'bg-primary/10 text-primary dark:bg-primary/20',
        success: 'bg-success/10 text-success dark:bg-success/15',
        warning: 'bg-warning/15 text-warning-foreground',
        destructive: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
      },
    },
    defaultVariants: {
      tone: 'neutral',
    },
  },
);

export type StatusPillProps = React.ComponentProps<'span'> &
  VariantProps<typeof statusPillVariants> & {
    // 是否带前导圆点(默认 true)
    dot?: boolean;
  };

export function StatusPill({ tone, dot = true, className, children, ...props }: StatusPillProps) {
  return (
    <span
      data-slot="status-pill"
      data-tone={tone ?? 'neutral'}
      className={cn(statusPillVariants({ tone }), className)}
      {...props}
    >
      {dot ? (
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      ) : null}
      {children}
    </span>
  );
}
