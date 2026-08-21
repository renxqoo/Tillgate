import type { ReactNode } from "react";

import type { Metadata } from "next";

import { Toaster } from "@ai-gateway/ui/components/ui/sonner";
import { TooltipProvider } from "@ai-gateway/ui/components/ui/tooltip";
import { fontVars } from "@ai-gateway/ui/lib/fonts/registry";
import { PREFERENCE_DEFAULTS } from "@ai-gateway/ui/lib/preferences/preferences-config";
import { getThemeBootCode } from "@ai-gateway/ui/scripts/theme-boot";
import { PreferencesStoreProvider } from "@ai-gateway/ui/stores/preferences/preferences-provider";

import { APP_CONFIG } from "@/config/app-config";

import "./globals.css";
import { Geist } from "next/font/google";
import { cn } from "@ai-gateway/ui";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

export const metadata: Metadata = {
  title: {
    default: `${APP_CONFIG.name} — 管理后台`,
    template: `%s — ${APP_CONFIG.name} 管理`,
  },
  description: `${APP_CONFIG.name} 运营后台：用户、渠道、模型、费率卡、统计`,
};

const bootCode = getThemeBootCode();

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { theme_mode, content_layout, navbar_style, sidebar_variant, sidebar_collapsible, font } =
    PREFERENCE_DEFAULTS;
  return (
    <html
      lang="zh-CN"
      data-theme-mode={theme_mode}
      data-content-layout={content_layout}
      data-navbar-style={navbar_style}
      data-sidebar-variant={sidebar_variant}
      data-sidebar-collapsible={sidebar_collapsible}
      data-font={font}
      suppressHydrationWarning className={cn("font-sans", geist.variable)}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: bootCode }} />
      </head>
      <body className={`${fontVars} min-h-screen antialiased`} suppressHydrationWarning>
        <TooltipProvider>
          <PreferencesStoreProvider initialValues={PREFERENCE_DEFAULTS}>
            {children}
            <Toaster />
          </PreferencesStoreProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
