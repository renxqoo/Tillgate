'use client';

// Toast 容器(sonner 封装): 主题取自本包 ThemeProvider(纯 React 实现, 替换模版默认的 next-themes);
// 未包 Provider 时交由 sonner 自身缺省主题处理
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type * as React from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

import { useThemeOptional } from '../primitives/theme-provider';

function Toaster({ ...props }: ToasterProps) {
  const theme = useThemeOptional();

  return (
    <Sonner
      theme={theme?.theme}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: 'cn-toast',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
