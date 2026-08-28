'use client';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@tillgate/ui';
import Link from 'next/link';

import type { NavDropdownItemProps } from './nav-shared';
import { CollapsedIconFallback } from './collapsed-icon-fallback';

export function NavDropdownItem({ item, isActive, isSubItemActive }: NavDropdownItemProps) {
  const Icon = item.icon;

  return (
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <SidebarMenuButton tooltip={item.title} isActive={isActive} disabled={item.disabled}>
              {Icon ? <Icon /> : <CollapsedIconFallback title={item.title} />}
              <span>{item.title}</span>
            </SidebarMenuButton>
          }
        />

        <DropdownMenuContent side="right" align="start" sideOffset={12} className="w-48">
          <DropdownMenuGroup>
            {item.subItems.map((subItem) => {
              const SubIcon = subItem.icon;

              return (
                <DropdownMenuItem
                  key={subItem.id}
                  disabled={subItem.disabled}
                  render={
                    <Link
                      prefetch={false}
                      href={subItem.url}
                      target={subItem.newTab ? '_blank' : undefined}
                      rel={subItem.newTab ? 'noreferrer' : undefined}
                      aria-current={isSubItemActive(subItem.url) ? 'page' : undefined}
                      className="flex items-center gap-2"
                    />
                  }
                >
                  {SubIcon && <SubIcon />}
                  <span>{subItem.title}</span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
