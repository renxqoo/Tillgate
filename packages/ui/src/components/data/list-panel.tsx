import type * as React from 'react';

import { cn } from '../../cn';

function ListPanel({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="list-panel"
      className={cn(
        'overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-border/50',
        className,
      )}
      {...props}
    />
  );
}

function ListToolbar({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-toolbar"
      className={cn(
        'flex flex-col gap-3 border-border/60 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
      {...props}
    />
  );
}

function ListToolbarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-toolbar-group"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}

function ListContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-content"
      className={cn(
        'min-w-0 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4 [&_tbody_td:last-child]:sticky [&_tbody_td:last-child]:right-0 [&_tbody_td:last-child]:z-10 [&_tbody_td:last-child]:bg-card [&_thead_th:last-child]:sticky [&_thead_th:last-child]:right-0 [&_thead_th:last-child]:z-20 [&_thead_th:last-child]:bg-card',
        className,
      )}
      {...props}
    />
  );
}

function ListFooter({ className, ...props }: React.ComponentProps<'footer'>) {
  return (
    <footer
      data-slot="list-footer"
      className={cn(
        'flex min-h-14 items-center border-border/60 border-t bg-muted/20 px-4 py-2',
        className,
      )}
      {...props}
    />
  );
}

export { ListPanel, ListToolbar, ListToolbarGroup, ListContent, ListFooter };
