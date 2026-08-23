'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { ConfirmDialog, toast } from '@tokenlens/ui';

import { actionResult } from './action-result';

/**
 * 确认弹窗 → pending → server action → toast 的统一封装（render-prop 拿
 * pending/onClick，不额外渲染 DOM 包裹层；不传 confirm 则跳过确认直接执行）。
 * 二次确认用 ui 包 ConfirmDialog(shadcn AlertDialog 风格),不用 window.confirm。
 */
export function ConfirmAction({
  confirm,
  action,
  errorTitle,
  success,
  tone = 'destructive',
  title,
  children,
}: {
  confirm?: string;
  /** 弹窗标题；缺省复用 ui.confirmTitle */
  title?: string;
  action: () => Promise<{ error?: string }>;
  errorTitle?: string;
  success?: string;
  /** 弹窗语气;删除等不可逆操作用 destructive(默认) */
  tone?: 'default' | 'destructive';
  children: (ctx: { pending: boolean; onClick: (e: MouseEvent) => void }) => ReactNode;
}) {
  const tUi = useTranslations('ui');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);

  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (confirm === undefined) {
      run();
      return;
    }
    setDialogOpen(true);
  }

  async function run() {
    setPending(true);
    try {
      const res = await action();
      actionResult(res, errorTitle, success);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      {children({ pending, onClick })}
      {confirm !== undefined ? (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={title ?? tUi('confirmTitle')}
          description={confirm}
          confirmLabel={tUi('confirm')}
          cancelLabel={tUi('cancel')}
          tone={tone}
          onConfirm={run}
          onError={(e) => toast.error(e instanceof Error ? e.message : String(e))}
        />
      ) : null}
    </>
  );
}
