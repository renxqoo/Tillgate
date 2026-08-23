'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { ConfirmDialog } from '@tokenlens/ui';

import { useActionResult } from './action-toast';

/**
 * 确认弹窗 → pending → server action → toast 的统一封装。
 *
 * 二次确认用 ui 包 ConfirmDialog(shadcn AlertDialog 风格),不用 window.confirm;
 * 弹窗标题/按钮文案走 ui 目录,确认消息由调用方注入。
 *
 * 用法(render-prop 拿 pending / onClick,不额外渲染 DOM 包裹层)：
 *
 *   <ConfirmAction
 *     confirm={t('deleteConfirm', { name })}
 *     action={async () => (await import("../actions")).deleteAction(id)}
 *     success={tc('deleted')}
 *   >
 *     {({ pending, onClick }) => (
 *       <Button size="sm" variant="ghost" disabled={pending} onClick={onClick}>…</Button>
 *     )}
 *   </ConfirmAction>
 *
 * toast 语义与旧代码一致：
 *   - errorTitle 传入 → toast.error(errorTitle, { description: res.error })
 *   - errorTitle 缺省 → toast.error(res.error)
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
  /** 确认弹窗正文文案；不传则跳过确认直接执行 */
  confirm?: string;
  /** 弹窗标题；缺省复用正文(无正文时弹窗不出现) */
  title?: string;
  /** 待执行的 server action（返回 { error?: string }） */
  action: () => Promise<{ error?: string }>;
  /** 失败 toast 标题；缺省时直接 toast.error(res.error) */
  errorTitle?: string;
  /** 成功 toast 文案 */
  success?: string;
  /** 弹窗语气;删除/封禁等不可逆操作用 destructive(默认) */
  tone?: 'default' | 'destructive';
  children: (ctx: { pending: boolean; onClick: (e: MouseEvent) => void }) => ReactNode;
}) {
  const tUi = useTranslations('ui');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const notify = useActionResult();

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
      notify(res, errorTitle, success);
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
