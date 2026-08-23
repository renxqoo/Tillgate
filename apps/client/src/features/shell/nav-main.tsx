'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@tokenlens/ui';

/**
 * 侧栏导航主区（app 内装配，新 ui 只提供 Sidebar 原语）。
 * 用户面板导航为纯平铺链接（无子级——v1 NavMain 的折叠/子项分支不移植，
 * 形状由本类型封闭），激活态按 pathname 前缀匹配。
 */
export interface NavMainItem {
  id: string;
  title: string;
  url: string;
  icon?: React.ComponentType<{ className?: string }>;
}

export interface NavGroup {
  id: string;
  label?: string;
  items: NavMainItem[];
}

export function NavMain({ items }: { items: readonly NavGroup[] }) {
  const pathname = usePathname();
  return (
    <>
      {items.map((group) => (
        <SidebarGroup key={group.id}>
          {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
          <SidebarGroupContent>
            <SidebarMenu>
              {group.items.map((item) => {
                const active =
                  item.url === '/dashboard'
                    ? pathname === '/dashboard'
                    : pathname.startsWith(item.url);
                const Icon = item.icon;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={active}
                      tooltip={item.title}
                      render={<Link prefetch={false} href={item.url} />}
                    >
                      {Icon ? <Icon className="size-4" /> : null}
                      <span>{item.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
}
