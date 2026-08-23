import type * as React from 'react';

import { cn } from '../../cn';

export type PageHeaderProps = Omit<React.ComponentProps<'header'>, 'title'> & {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
};

/**
 * 应用页头：统一标题、说明、计数与页面级动作的响应式节奏。
 * 只负责排版，不持有路由或国际化状态。
 */
function PageHeader({
  title,
  description,
  icon,
  meta,
  actions,
  className,
  ...props
}: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}
      {...props}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          {icon ? (
            <span
              data-slot="page-header-icon"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4"
            >
              {icon}
            </span>
          ) : null}
          <h1 className="truncate text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {meta ? <div className="shrink-0">{meta}</div> : null}
        </div>
        {description ? (
          <p className={cn('max-w-3xl text-sm text-muted-foreground', icon && 'sm:pl-10')}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div
          data-slot="page-header-actions"
          className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto sm:justify-end"
        >
          {actions}
        </div>
      ) : null}
    </header>
  );
}

export { PageHeader };
