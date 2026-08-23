'use client';

// 主题切换器: 单按钮直接在明/暗两态间点击切换(无菜单、不提供 system 选项);
// 依赖本包 ThemeProvider 的 resolvedTheme; aria 文案可注入本地化
import { MoonIcon, SunIcon } from 'lucide-react';

import { useTheme } from '../primitives/theme-provider';
import { Button } from '../primitives/button';

export type ThemeSwitcherProps = {
  /** 按钮 aria-label(本地化注入) */
  label?: string;
};

export function ThemeSwitcher({ label = 'Toggle theme' }: ThemeSwitcherProps) {
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={resolvedTheme === 'dark'}
      data-slot="theme-switcher"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      {resolvedTheme === 'dark' ? <MoonIcon /> : <SunIcon />}
    </Button>
  );
}
