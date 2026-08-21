"use client";

import Link from "next/link";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@ai-gateway/ui/components/ui/sidebar";
import { APP_CONFIG } from "@/config/app-config";
import { buildSidebarItems } from "@/navigation/sidebar/sidebar-items";

import { NavMain } from "@ai-gateway/ui/components/shell/sidebar/nav-main";
import { NavUser } from "./nav-user";

export interface SidebarUser {
  readonly name: string;
  readonly email: string;
  readonly avatar: string;
}

export function AppSidebar({
  user,
  referralEnabled,
  ...props
}: React.ComponentProps<typeof Sidebar> & { readonly user: SidebarUser; readonly referralEnabled?: boolean }) {
  const t = useTranslations("nav");


  // sidebar-items 的 title/label 存 nav 命名空间 key，这里统一翻译后再交给 NavMain
  const items = buildSidebarItems({ referralEnabled }).map((group) => ({
    ...group,
    label: group.label ? t(group.label) : undefined,
    items: group.items.map((item) => ({
      ...item,
      title: t(item.title),
    })),
  }));

  return (
    <Sidebar {...props}>
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
                  <span className="text-[10px] text-muted-foreground">{t("subtitle")}</span>
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
