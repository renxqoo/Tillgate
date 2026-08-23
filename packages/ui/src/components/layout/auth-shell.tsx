import type * as React from 'react';

import { cn } from '../../cn';

export type AuthShellProps = React.ComponentProps<'main'> & {
  brand: React.ReactNode;
  children: React.ReactNode;
  asideIcon?: React.ReactNode;
  asideTitle: React.ReactNode;
  asideDescription?: React.ReactNode;
  asideFooter?: React.ReactNode;
};

/**
 * 认证页应用壳：移动端聚焦表单，大屏提供独立品牌说明区。
 * 内容完全由应用注入，避免 UI 包依赖 Next、国际化或业务配置。
 */
function AuthShell({
  brand,
  children,
  asideIcon,
  asideTitle,
  asideDescription,
  asideFooter,
  className,
  ...props
}: AuthShellProps) {
  return (
    <main
      data-slot="auth-shell"
      className={cn('grid min-h-svh bg-muted/40 p-2 lg:grid-cols-2 lg:gap-2', className)}
      {...props}
    >
      <section className="relative flex min-h-[calc(100svh-1rem)] flex-col rounded-2xl border bg-background p-6 shadow-xs md:p-10">
        <div className="flex items-center self-start">{brand}</div>
        <div className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </section>

      <aside className="relative hidden min-h-[calc(100svh-1rem)] overflow-hidden rounded-2xl border bg-linear-to-br from-muted/80 via-background to-primary/5 p-10 lg:flex lg:flex-col lg:items-center lg:justify-center">
        <div className="absolute -top-24 -right-24 size-72 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative max-w-md space-y-4 text-center">
          {asideIcon ? (
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm [&_svg]:size-7">
              {asideIcon}
            </div>
          ) : null}
          <h2 className="text-2xl font-semibold tracking-tight text-balance">{asideTitle}</h2>
          {asideDescription ? (
            <p className="text-sm/relaxed text-muted-foreground text-pretty">{asideDescription}</p>
          ) : null}
          {asideFooter ? (
            <div className="pt-3 text-xs text-muted-foreground">{asideFooter}</div>
          ) : null}
        </div>
      </aside>
    </main>
  );
}

export { AuthShell };
