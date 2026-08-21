import type { ReactNode } from "react";

import { cookies } from "next/headers";

import { Separator } from "@ai-gateway/ui/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@ai-gateway/ui/components/ui/sidebar";
import { cn } from "@ai-gateway/ui/lib/utils";

import { AccountSwitcher } from "@ai-gateway/ui/components/shell/header/account-switcher";
import { LocaleSwitcher } from "@ai-gateway/ui/components/shell/header/locale-switcher";
import { ThemeSwitcher } from "@ai-gateway/ui/components/shell/header/theme-switcher";
import { AppSidebar } from "@/components/shell/sidebar/app-sidebar";
import { logoutAction } from "@/lib/server-actions/auth";
import { requireAdmin, userFromAdminMe } from "@/lib/server/get-user";

export const dynamic = "force-dynamic";

export default async function MainLayout({ children }: Readonly<{ children: ReactNode }>) {
  const me = await requireAdmin();
  const user = userFromAdminMe(me);

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
      <AppSidebar user={user} />
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
              <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4 data-[orientation=vertical]:self-center" />
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
