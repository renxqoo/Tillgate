'use client';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@tokenlens/ui';
import Link from 'next/link';

import { ShieldCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { APP_CONFIG } from '@/config/app-config';
import { buildSidebarItems } from '@/config/sidebar-items';

import { NavMain } from '@/components/shell/sidebar/nav-main';
import { NavUser } from './nav-user';

export interface SidebarUser {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

export function AppSidebar({
  user,
  permissions = [],
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  readonly user: SidebarUser;
  /** 当前角色全量权限集（/v1/me 下发——RBAC 导航过滤单一事实来源） */
  readonly permissions?: readonly string[];
}) {
  const t = useTranslations('nav');

  // sidebar-items 存 i18n key，这里解析成当前语言文案再交给共享 NavMain 渲染；
  // 无权限的入口整项隐藏（权限权威判定在 admin-api 域守卫——此处仅为导航 UX）
  const allowed = (permission?: string) => permission == null || permissions.includes(permission);
  const items = buildSidebarItems()
    .map((group) => ({
      ...group,
      label: group.label ? t(group.label) : undefined,
      items: group.items
        .filter((item) => allowed(item.permission))
        .map((item) =>
          item.subItems != null
            ? { ...item, subItems: item.subItems.filter((sub) => allowed(sub.permission)) }
            : item,
        )
        .map((item) => ({ ...item, title: t(item.title) })),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="data-[slot=sidebar-menu-button]:!p-1.5 h-10"
              render={
                <Link prefetch={false} href="/dashboard" aria-label={t('home')}>
                  <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                    <ShieldCheck className="size-4" />
                  </div>
                  <div className="flex flex-col gap-0 leading-tight">
                    <span className="font-semibold text-sm">{APP_CONFIG.name}</span>
                    <span className="text-[10px] text-muted-foreground">{t('subtitle')}</span>
                  </div>
                </Link>
              }
            />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser
          user={{
            name: user.name,
            email: user.email,
            avatar: user.avatar,
          }}
        />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
