'use client';

import type * as React from 'react';
import { MoreHorizontalIcon } from 'lucide-react';

import { cn } from '../../cn';
import { Button } from '../primitives/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';

interface RowActionsProps {
  /** 三点按钮的无障碍名称，由应用层传入当前语言文案。 */
  label: string;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Base Nova 表格行操作：固定 28px 三点触发器，菜单右对齐。
 * 菜单项由调用方使用 DropdownMenuItem / Separator 组合，业务行为不下沉。
 */
function RowActions({ label, children, className, contentClassName }: RowActionsProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn('text-muted-foreground data-popup-open:bg-muted', className)}
            aria-label={label}
            title={label}
          />
        }
      >
        <MoreHorizontalIcon />
        <span className="sr-only">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={cn('w-40', contentClassName)}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { RowActions, type RowActionsProps };
