"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { Button } from "../../ui/button";
import { usePreferencesStore } from "../../../stores/preferences/preferences-provider";

const THEME_CYCLE = ["light", "dark", "system"] as const;
type ThemeModeValue = (typeof THEME_CYCLE)[number];

export function ThemeSwitcher() {
  const { themeMode, setPreference } = usePreferencesStore(
    useShallow((state) => ({
      themeMode: (state.values.theme_mode ?? "light") as ThemeModeValue,
      setPreference: state.setPreference,
    })),
  );

  const cycleTheme = () => {
    const currentIndex = THEME_CYCLE.indexOf(themeMode);
    const nextTheme: ThemeModeValue =
      THEME_CYCLE[(currentIndex + 1) % THEME_CYCLE.length] ?? "light";

    setPreference("theme_mode", nextTheme);
  };

  return (
    <Button size="icon" onClick={cycleTheme} aria-label={`当前主题 ${themeMode}，点击切换`}>
      <Monitor className="hidden [html[data-theme-mode=system]_&]:block" />
      <Sun className="hidden dark:block [html[data-theme-mode=system]_&]:hidden" />
      <Moon className="block dark:hidden [html[data-theme-mode=system]_&]:hidden" />
    </Button>
  );
}
