'use client';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarSeparator,
} from '@tillgate/ui';
import { Fragment } from 'react';
import { usePathname } from 'next/navigation';

import {
  hasSubItems,
  type NavMainItem,
  type NavMainParentItem,
  type NavMainProps,
} from './nav-shared';
import { NavItem } from './nav-item';

export type {
  NavBadge,
  NavGroup,
  NavMainItem,
  NavMainLinkItem,
  NavMainParentItem,
  NavSubItem,
} from './nav-shared';

export function NavMain({ items }: NavMainProps) {
  const path = usePathname();

  const isItemActive = (item: NavMainItem) => {
    if (hasSubItems(item)) {
      return item.subItems.some((sub) => path.startsWith(sub.url));
    }

    return path === item.url;
  };

  const isSubItemActive = (url: string) => path === url;

  const isSubmenuOpen = (item: NavMainParentItem) =>
    item.subItems.some((sub) => path.startsWith(sub.url));

  return (
    <>
      {items.map((group, index) => (
        <Fragment key={group.id}>
          {index > 0 ? (
            <SidebarSeparator className="w-auto! group-data-[collapsible=icon]:hidden" />
          ) : null}
          <SidebarGroup className={index === 0 ? 'pb-1' : 'py-1'}>
            {group.label && (
              <SidebarGroupLabel className="group-data-[collapsible=icon]:pointer-events-none">
                {group.label}
              </SidebarGroupLabel>
            )}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavItem
                    key={item.id}
                    item={item}
                    isItemActive={isItemActive}
                    isSubItemActive={isSubItemActive}
                    isSubmenuOpen={isSubmenuOpen}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Fragment>
      ))}
    </>
  );
}
