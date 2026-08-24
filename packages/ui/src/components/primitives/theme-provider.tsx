'use client';

/* eslint-disable react-refresh/only-export-components */
import * as React from 'react';

type Theme = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';

interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
  disableTransitionOnChange?: boolean;
}

interface ThemeProviderState {
  theme: Theme;
  /** system 解析后的实际生效主题(明/暗),供切换器等消费方展示当前态 */
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
}

const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)';
const THEME_VALUES: Theme[] = ['dark', 'light', 'system'];

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(undefined);

function isTheme(value: string | null): value is Theme {
  if (value === null) {
    return false;
  }

  return THEME_VALUES.includes(value as Theme);
}

function getSystemTheme(): ResolvedTheme {
  if (window.matchMedia(COLOR_SCHEME_QUERY).matches) {
    return 'dark';
  }

  return 'light';
}

function disableTransitionsTemporarily() {
  const style = document.createElement('style');
  style.appendChild(
    document.createTextNode(
      '*,*::before,*::after{-webkit-transition:none!important;transition:none!important}',
    ),
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        style.remove();
      });
    });
  };
}

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const editableParent = target.closest("input, textarea, select, [contenteditable='true']");
  if (editableParent) {
    return true;
  }

  return false;
}

// 模块级：快捷键主题轮换(dark/light 互切, system 按当前系统偏好切到另一侧)
function cycleTheme(currentTheme: Theme): Theme {
  if (currentTheme === 'dark') {
    return 'light';
  }
  if (currentTheme === 'light') {
    return 'dark';
  }
  return getSystemTheme() === 'dark' ? 'light' : 'dark';
}

export function ThemeProvider({
  children,
  defaultTheme = 'system',
  storageKey = 'theme',
  disableTransitionOnChange = true,
  ...props
}: ThemeProviderProps) {
  // SSR/水合安全: 首帧统一 defaultTheme(服务端无 localStorage,且服务端与客户端
  // 首渲染必须一致防水合错位); 存储值在挂载 effect 中同步——首屏正确类名由宿主
  // 注入的 boot script 负责(layout 防FOUC), 此处不承担。resolvedTheme 首帧由
  // defaultTheme 推导(system 视作 light), 挂载后随真实系统偏好/存储值校正
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [resolvedTheme, setResolvedTheme] = React.useState<ResolvedTheme>(
    defaultTheme === 'dark' ? 'dark' : 'light',
  );

  React.useEffect(() => {
    const storedTheme = localStorage.getItem(storageKey);
    if (isTheme(storedTheme)) {
      // eslint-disable-next-line react/set-state-in-effect -- 挂载时从 localStorage(外部系统)同步持久化主题；首帧必须用 defaultTheme 保证 SSR/水合一致，只能挂载后校正
      setThemeState(storedTheme);
    }
  }, [storageKey]);

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      localStorage.setItem(storageKey, nextTheme);
      setThemeState(nextTheme);
    },
    [storageKey],
  );

  const applyTheme = React.useCallback(
    (nextTheme: Theme) => {
      const root = document.documentElement;
      const resolved = nextTheme === 'system' ? getSystemTheme() : nextTheme;
      const restoreTransitions = disableTransitionOnChange ? disableTransitionsTemporarily() : null;

      root.classList.remove('light', 'dark');
      root.classList.add(resolved);
      // colorScheme 与类名同步(原生控件/滚动条配色); 与宿主 boot script 行为一致
      root.style.colorScheme = resolved;
      setResolvedTheme(resolved);

      if (restoreTransitions) {
        restoreTransitions();
      }
    },
    [disableTransitionOnChange],
  );

  React.useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- 副作用是把主题同步到 DOM(外部系统)；resolvedTheme 依赖 window 系统偏好，SSR 渲染期不可得，只能在 effect 中派生回填
    applyTheme(theme);

    if (theme !== 'system') {
      return;
    }

    const mediaQuery = window.matchMedia(COLOR_SCHEME_QUERY);
    const handleChange = () => {
      applyTheme('system');
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [theme, applyTheme]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }

      if (event.key.toLowerCase() !== 'd') {
        return;
      }

      setThemeState((currentTheme) => {
        const nextTheme = cycleTheme(currentTheme);

        localStorage.setItem(storageKey, nextTheme);
        return nextTheme;
      });
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [storageKey]);

  React.useEffect(() => {
    const handleStorageChange = (event: StorageEvent) => {
      if (event.storageArea !== localStorage) {
        return;
      }

      if (event.key !== storageKey) {
        return;
      }

      if (isTheme(event.newValue)) {
        setThemeState(event.newValue);
        return;
      }

      setThemeState(defaultTheme);
    };

    window.addEventListener('storage', handleStorageChange);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
    };
  }, [defaultTheme, storageKey]);

  const value = React.useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
    }),
    [theme, resolvedTheme, setTheme],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = React.useContext(ThemeProviderContext);

  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }

  return context;
};

// 非抛错读取: 供可选主题的组件(如 Toaster)在未包 Provider 时优雅降级
export const useThemeOptional = () => React.useContext(ThemeProviderContext);
