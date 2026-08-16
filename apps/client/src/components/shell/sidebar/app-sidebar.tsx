"use client";

import Link from "next/link";

import { Sparkles } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@ai-gateway/ui/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { buildSidebarItems } from "@/navigation/sidebar/sidebar-items";
import { usePreferencesStore } from "@ai-gateway/ui/stores/preferences/preferences-provider";

import { NavMain } from "@ai-gateway/ui/components/shell/sidebar/nav-main";
import { NavUser } from "./nav-user";
import { SupportCard } from "./support-card";

export interface SidebarUser {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

export function AppSidebar({
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & { readonly user: SidebarUser }) {
  const { sidebarVariant, sidebarCollapsible, isSynced } = usePreferencesStore(
    useShallow((s) => ({
      sidebarVariant: s.values.sidebar_variant,
      sidebarCollapsible: s.values.sidebar_collapsible,
      isSynced: s.isSynced,
    })),
  );

  const variant = isSynced ? sidebarVariant : props.variant;
  const collapsible = isSynced ? sidebarCollapsible : props.collapsible;

  const items = buildSidebarItems();

  return (
    <Sidebar {...props} variant={variant} collapsible={collapsible}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5 h-10"
            >
              <Link prefetch={false} href="/dashboard" aria-label="Home">
                <div className="flex aspect-square size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                  <Sparkles className="size-4" />
                </div>
                <div className="flex flex-col gap-0 leading-tight">
                  <span className="font-semibold text-sm">{APP_CONFIG.name}</span>
                  <span className="text-[10px] text-muted-foreground">端用户面板</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={items} />
      </SidebarContent>
      <SidebarFooter>
        <SupportCard />
        <NavUser
          user={{
            name: user.name,
            email: user.email,
            avatar: user.avatar,
          }}
        />
      </SidebarFooter>
    </Sidebar>
  );
}
