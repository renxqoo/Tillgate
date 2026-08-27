'use client';

import { SidebarMenuBadge } from '@tillgate/ui';

import { cn } from '@/lib/utils';

import type { NavBadge } from './nav-shared';

export function NavItemBadge({ badge }: { badge?: NavBadge }) {
  if (!badge) {
    return null;
  }

  return (
    <SidebarMenuBadge
      className={cn(
        'rounded-sm border capitalize',
        badge === 'new' &&
          'border-green-600 text-green-600 peer-hover/menu-button:text-green-600 peer-data-active/menu-button:text-green-600',
        badge === 'soon' && 'border-muted-foreground text-muted-foreground',
      )}
    >
      {badge}
    </SidebarMenuBadge>
  );
}
