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
import { menuIconOf } from '@/config/menu-icons';

import { NavMain } from '@/components/shell/sidebar/nav-main';
import { NavUser } from './nav-user';

export interface SidebarUser {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

/** layout 解析好的菜单树（/v1/me/menus 后端驱动——labels 与图标已映射,纯渲染） */
export interface SidebarMenuGroup {
  readonly label: string | null;
  readonly items: readonly {
    readonly title: string;
    readonly url: string;
    readonly iconName: string | null;
  }[];
}

export function AppSidebar({
  user,
  groups,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  readonly user: SidebarUser;
  readonly groups: readonly SidebarMenuGroup[];
}) {
  const t = useTranslations('nav');

  const items = groups.map((group, index) => ({
    id: index + 1,
    ...(group.label != null ? { label: group.label } : {}),
    items: group.items.map((item) => ({
      id: item.url,
      title: item.title,
      url: item.url,
      icon: menuIconOf(item.iconName),
    })),
  }));

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
