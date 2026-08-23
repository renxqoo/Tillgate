'use client';

import Link from 'next/link';

import { Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

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

import { APP_CONFIG } from '@/config/app-config';

import { NavMain } from './nav-main';
import { NavUser } from './nav-user';
import { buildSidebarItems } from './sidebar-items';
import type { SidebarUser } from './types';

export function AppSidebar({
  user,
  referralEnabled,
  ...props
}: React.ComponentProps<typeof Sidebar> & { user: SidebarUser; referralEnabled?: boolean }) {
  const t = useTranslations('nav');

  // sidebar-items 的 title/label 存 nav 命名空间 key，这里统一翻译后再交给 NavMain
  const items = buildSidebarItems({ referralEnabled }).map((group) => ({
    ...group,
    label: group.label ? t(group.label) : undefined,
    items: group.items.map((item) => ({ ...item, title: t(item.title) })),
  }));

  return (
    <Sidebar variant="inset" collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<Link prefetch={false} href="/dashboard" aria-label="Home" />}
              className="data-[slot=sidebar-menu-button]:!p-1.5 h-10"
            >
              <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Sparkles className="size-4" />
              </div>
              <div className="flex flex-col gap-0 leading-tight">
                <span className="font-semibold text-sm">{APP_CONFIG.name}</span>
                <span className="text-[10px] text-muted-foreground">{t('subtitle')}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
