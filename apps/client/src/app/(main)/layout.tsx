import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { Separator } from "@ai-gateway/ui/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@ai-gateway/ui/components/ui/sidebar";
import { cn } from "@ai-gateway/ui/lib/utils";

import { AccountSwitcher } from "@ai-gateway/ui/components/shell/header/account-switcher";
import { LocaleSwitcher } from "@ai-gateway/ui/components/shell/header/locale-switcher";
import { ThemeSwitcher } from "@ai-gateway/ui/components/shell/header/theme-switcher";
import { apiFetch } from '@ai-gateway/api-client';
import { AppSidebar } from "@/components/shell/sidebar/app-sidebar";
import { logoutAction } from "@/lib/server-actions/auth";
import { requireMe, userFromMe } from "@/lib/server/get-user";

export const dynamic = "force-dynamic";

export default async function MainLayout({ children }: Readonly<{ children: ReactNode }>) {
  // 邀请功能开关（营销参数 DB 化）：两项激励全 0 时隐藏入口；查询失败保守显示（页面空态兜底）
  const referralConfig = await apiFetch<{ enabled: boolean }>('/v1/referrals/config').catch(() => null);
  const referralEnabled = referralConfig?.enabled ?? true;

  const me = await requireMe();
  const user = userFromMe(me);

  const cookieStore = await cookies();
  const defaultOpen = cookieStore.get("sidebar_state")?.value !== "false";

  return (
    <SidebarProvider
      defaultOpen={defaultOpen}
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 68)",
        } as React.CSSProperties
      }
    >
      <AppSidebar user={user} referralEnabled={referralEnabled} />
      <SidebarInset
        className={cn(
          "peer-data-[variant=inset]:border",
          "[--dashboard-header-height:3rem]",
          "min-w-0 overflow-x-clip",
        )}
      >
        <header
          className={cn(
            "flex h-12 shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12",
          )}
        >
          <div className="flex w-full items-center justify-between px-4 lg:px-6">
            <div className="flex items-center gap-1 lg:gap-2">
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center"
              />
            </div>
            <div className="flex items-center gap-2">
              <ThemeSwitcher />
              <LocaleSwitcher />
              <AccountSwitcher user={{ name: user.name, email: user.email }} onLogout={logoutAction} />
            </div>
          </div>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden p-4 has-data-[content-padding=false]:p-0 md:p-6 md:has-data-[content-padding=false]:p-0">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
