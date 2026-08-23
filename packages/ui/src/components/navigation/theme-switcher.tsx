// 主题切换器: 依赖本包 ThemeProvider(纯 React 实现); 选项文案可注入本地化
import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';

import { useTheme } from '../primitives/theme-provider';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';

export type ThemeSwitcherLabels = {
  trigger?: string;
  light?: string;
  dark?: string;
  system?: string;
};

export type ThemeSwitcherProps = {
  labels?: ThemeSwitcherLabels;
  align?: 'start' | 'center' | 'end';
};

const LABEL_DEFAULTS: Required<ThemeSwitcherLabels> = {
  trigger: 'Change theme',
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function ThemeSwitcher({ labels, align = 'end' }: ThemeSwitcherProps) {
  const { theme, setTheme } = useTheme();
  const text = { ...LABEL_DEFAULTS, ...labels };

  const options = [
    { value: 'light' as const, label: text.light, icon: SunIcon },
    { value: 'dark' as const, label: text.dark, icon: MoonIcon },
    { value: 'system' as const, label: text.system, icon: MonitorIcon },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={text.trigger}
            data-slot="theme-switcher-trigger"
          >
            {theme === 'dark' ? <MoonIcon /> : <SunIcon />}
          </Button>
        }
      />
      <DropdownMenuContent align={align} data-slot="theme-switcher">
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
            <option.icon className="size-4" />
            {option.label}
            {theme === option.value ? <CheckIcon className="ms-auto size-4" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
