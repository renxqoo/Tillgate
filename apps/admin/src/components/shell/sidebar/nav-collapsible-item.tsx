'use client';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@tillgate/ui';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';

import type { NavCollapsibleItemProps } from './nav-shared';
import { NavItemBadge } from './nav-item-badge';

export function NavCollapsibleItem({
  item,
  isActive,
  defaultOpen,
  isSubItemActive,
}: NavCollapsibleItemProps) {
  const Icon = item.icon;

  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className="group/collapsible"
      render={
        <SidebarMenuItem>
          <CollapsibleTrigger
            render={
              <SidebarMenuButton
                tooltip={item.title}
                isActive={isActive}
                disabled={item.disabled}
              />
            }
          >
            {Icon && <Icon />}
            <span>{item.title}</span>
            <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
          <NavItemBadge badge={item.badge} />

          <CollapsibleContent>
            <SidebarMenuSub>
              {item.subItems.map((subItem) => {
                const SubIcon = subItem.icon;

                return (
                  <SidebarMenuSubItem key={subItem.id}>
                    <SidebarMenuSubButton
                      aria-disabled={subItem.disabled}
                      isActive={isSubItemActive(subItem.url)}
                      render={
                        <Link
                          prefetch={false}
                          href={subItem.url}
                          target={subItem.newTab ? '_blank' : undefined}
                          rel={subItem.newTab ? 'noreferrer' : undefined}
                        />
                      }
                    >
                      {SubIcon && <SubIcon />}
                      <span>{subItem.title}</span>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      }
    />
  );
}
