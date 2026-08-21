"use client";

import { useEffect, useState } from "react";

import { useTranslations } from "next-intl";
import { Monitor, Moon, Sun } from "lucide-react";

import { Button } from "../../ui/button";
import { setClientCookie } from "../../../lib/cookie.client";
import { applyThemeMode } from "../../../lib/preferences/theme-utils";
import type { ThemeMode } from "../../../lib/preferences/theme";

const THEME_CYCLE = ["light", "dark", "system"] as const;

/** 主题切换（light → dark → system 循环）：写 theme_mode cookie，boot 脚本下次首屏直用 */
export function ThemeSwitcher() {
  const t = useTranslations("ui");
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");

  useEffect(() => {
    const raw = document.documentElement.getAttribute("data-theme-mode");
    if (raw === "dark" || raw === "system") setThemeMode(raw);
  }, []);

  function cycleTheme() {
    const currentIndex = THEME_CYCLE.indexOf(themeMode);
    const next: ThemeMode = THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length] ?? "light";
    applyThemeMode(next);
    setClientCookie("theme_mode", next);
    setThemeMode(next);
  }

  return (
    <Button size="icon" onClick={cycleTheme} aria-label={t("themeToggle", { mode: themeMode })}>
      <Monitor className="hidden [html[data-theme-mode=system]_&]:block" />
      <Sun className="hidden dark:block [html[data-theme-mode=system]_&]:hidden" />
      <Moon className="block dark:hidden [html[data-theme-mode=system]_&]:hidden" />
    </Button>
  );
}
