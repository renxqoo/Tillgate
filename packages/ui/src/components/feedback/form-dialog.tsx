'use client';

// 表单对话框: Dialog 内置 <form>, 提交走 onSubmit 异步流(pending 锁按钮), 成功后自动关闭。
// 行为契约与 ConfirmDialog 一致: reject 保持打开并交给 onError(未提供则原样上抛)。
import * as React from 'react';

import { cn } from '../../cn';
import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../primitives/dialog';

export interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  // 按钮文案必填: 不藏默认文案, 本地化由调用方注入
  submitLabel: string;
  cancelLabel: string;
  onSubmit: () => unknown | Promise<unknown>;
  submitDisabled?: boolean;
  // 表单控件内容(Field/Input 等由调用方组合)
  children: React.ReactNode;
  contentClassName?: string;
  onError?: (error: unknown) => void;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  cancelLabel,
  onSubmit,
  submitDisabled = false,
  children,
  contentClassName,
  onError,
}: FormDialogProps) {
  const [pending, setPending] = React.useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    // jsdom/浏览器默认不阻止; 统一走受控异步流
    event.preventDefault();
    setPending(true);
    try {
      await onSubmit();
      onOpenChange(false);
    } catch (error) {
      if (onError) {
        onError(error);
      } else {
        throw error;
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="form-dialog" className={cn('sm:max-w-md', contentClassName)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="grid gap-4">{children}</div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              disabled={pending || submitDisabled}
              data-slot="form-dialog-submit"
            >
              {pending ? <Spinner className="size-3.5" /> : null}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
