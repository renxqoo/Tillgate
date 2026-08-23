// 确认对话框: 危险/不可逆操作二次确认。
// 行为契约: onConfirm resolve 后自动关闭; reject 时保持打开并把错误交给 onError(未提供则原样上抛)。
import { TriangleAlertIcon } from 'lucide-react';
import * as React from 'react';

import { Button } from '../primitives/button';
import { Spinner } from '../primitives/spinner';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '../primitives/alert-dialog';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  // 按钮文案必填: 不藏默认文案, 本地化由调用方注入
  confirmLabel: string;
  cancelLabel: string;
  // destructive 时确认按钮为危险色并附警示图标
  tone?: 'default' | 'destructive';
  onConfirm: () => unknown | Promise<unknown>;
  // onConfirm 抛错时的回调(提示 toast 等); 缺省则原样上抛
  onError?: (error: unknown) => void;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  onConfirm,
  onError,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);

  async function handleConfirm() {
    setPending(true);
    try {
      await onConfirm();
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
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-slot="confirm-dialog" data-tone={tone}>
        <AlertDialogHeader>
          {tone === 'destructive' ? (
            <AlertDialogMedia>
              <TriangleAlertIcon className="size-4" />
            </AlertDialogMedia>
          ) : null}
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            disabled={pending}
            data-slot="confirm-dialog-confirm"
            onClick={() => void handleConfirm()}
          >
            {pending ? <Spinner className="size-3.5" /> : null}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
