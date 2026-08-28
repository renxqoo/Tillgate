'use client';

import { SidebarMenuButton, SidebarMenuItem } from '@tillgate/ui';
import Link from 'next/link';

import type { NavLinkItemProps } from './nav-shared';
import { NavLinkIcon } from './nav-link-icon';
import { NavItemBadge } from './nav-item-badge';

export function NavLinkItem({ item, isActive, showIconFallback }: NavLinkItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-disabled={item.disabled}
        tooltip={item.title}
        isActive={isActive}
        render={
          <Link
            prefetch={false}
            href={item.url}
            target={item.newTab ? '_blank' : undefined}
            rel={item.newTab ? 'noreferrer' : undefined}
          >
            <NavLinkIcon item={item} showFallback={showIconFallback} />
            <span>{item.title}</span>
          </Link>
        }
      />
      <NavItemBadge badge={item.badge} />
    </SidebarMenuItem>
  );
}
