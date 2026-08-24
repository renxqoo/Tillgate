import {
  Separator,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  ThemeSwitcher,
} from '@tillgate/ui';
import type { ReactNode } from 'react';

import { cookies } from 'next/headers';

import { AccountSwitcher } from '@/components/shell/header/account-switcher';
import { LocaleSwitcher } from '@/components/shell/header/locale-switcher';
import { AppSidebar } from '@/components/shell/sidebar/app-sidebar';
import { APP_CONFIG } from '@/config/app-config';
import { logoutAction } from '@/server/auth-actions';
import { requireAdmin, requireMenus, userFromAdminMe } from '@/server/get-admin';

export const dynamic = 'force-dynamic';

export default async function MainLayout({ children }: Readonly<{ children: ReactNode }>) {
  const me = await requireAdmin();
  const user = userFromAdminMe(me);
  const menuGroups = (await requireMenus()).map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      title: item.name,
      url: item.path ?? '/dashboard',
      iconName: item.icon,
    })),
  }));

  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get('sidebar_state')?.value !== 'false';

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          '--sidebar-width': 'calc(var(--spacing) * 72)',
          '--header-height': 'calc(var(--spacing) * 12)',
        } as React.CSSProperties
      }
    >
      <AppSidebar user={user} groups={menuGroups} />
      <SidebarInset className="min-w-0 overflow-x-clip md:!m-0 md:!rounded-none md:!shadow-none">
        <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 bg-background/85 backdrop-blur-md transition-[width,height] ease-linear supports-[backdrop-filter]:bg-background/70">
          <div className="flex w-full items-center justify-between px-5 md:px-6 lg:px-8 xl:px-10">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
              />
              <span className="hidden text-sm font-medium sm:inline">{APP_CONFIG.name}</span>
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              <LocaleSwitcher />
              <AccountSwitcher
                user={{ name: user.name, email: user.email }}
                onLogout={logoutAction}
              />
            </div>
          </div>
        </header>
        <div className="@container/main min-h-0 min-w-0 flex-1 overflow-x-hidden px-5 py-5 has-data-[content-padding=false]:p-0 md:px-6 md:py-6 lg:px-8 xl:px-10 md:has-data-[content-padding=false]:p-0">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
