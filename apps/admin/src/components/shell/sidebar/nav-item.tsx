'use client';

import { useSidebar } from '@tillgate/ui';

import { hasSubItems, type NavItemProps } from './nav-shared';
import { NavCollapsibleItem } from './nav-collapsible-item';
import { NavDropdownItem } from './nav-dropdown-item';
import { NavLinkItem } from './nav-link-item';

export function NavItem({ item, isItemActive, isSubItemActive, isSubmenuOpen }: NavItemProps) {
  const { state, isMobile } = useSidebar();
  const isCollapsedDesktop = state === 'collapsed' && !isMobile;

  if (!hasSubItems(item)) {
    return (
      <NavLinkItem
        item={item}
        isActive={isItemActive(item)}
        showIconFallback={isCollapsedDesktop}
      />
    );
  }

  if (isCollapsedDesktop) {
    return (
      <NavDropdownItem
        item={item}
        isActive={isItemActive(item)}
        isSubItemActive={isSubItemActive}
      />
    );
  }

  return (
    <NavCollapsibleItem
      item={item}
      isActive={isItemActive(item)}
      defaultOpen={isSubmenuOpen(item)}
      isSubItemActive={isSubItemActive}
    />
  );
}
