'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { ConfirmDialog } from '@tillgate/ui';

import { useActionResult } from './action-toast';

/**
 * 确认弹窗 → pending → server action → toast 的统一封装。
 *
 * 二次确认用 ui 包 ConfirmDialog(shadcn AlertDialog 风格),不用 window.confirm;
 * 弹窗标题/按钮文案走 ui 目录,确认消息由调用方注入。
 *
 * 触发器是菜单项(DropdownMenuItem)时,禁止把本组件塞进 RowActions/菜单
 * content 里:菜单点选后关闭会卸载整个 content,弹窗连同内部状态一起被卸掉,
 * 表现为弹窗闪一下就消失。这种情况改用受控模式——菜单项 onClick 只调
 * onOpenChange(true),本组件挂在菜单外(与 EditModelDialog 等摆法一致)。
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
 * 菜单项触发的受控用法(本组件在菜单外,children 不传):
 *
 *   <DropdownMenuItem onClick={() => setDialog('delete')}>…</DropdownMenuItem>
 *   <ConfirmAction
 *     open={dialog === 'delete'}
 *     onOpenChange={(open) => !open && setDialog(null)}
 *     …
 *   />
 *
 * toast 语义与旧代码一致：
 *   - errorTitle 传入 → toast.error(errorTitle, { description: res.error })
 *   - errorTitle 缺省 → toast.error(res.error)
 */
export function ConfirmAction({
  confirm,
  open: openProp,
  onOpenChange,
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
  /** 外部受控打开状态(触发器在菜单里时必用,见顶部注释);须与 onOpenChange 成对传 */
  open?: boolean;
  /** 受控模式的关闭回调(取消/确认成功后由 ConfirmDialog 调 false) */
  onOpenChange?: (open: boolean) => void;
  /** 待执行的 server action（返回 { error?: string }） */
  action: () => Promise<{ error?: string }>;
  /** 失败 toast 标题；缺省时直接 toast.error(res.error) */
  errorTitle?: string;
  /** 成功 toast 文案 */
  success?: string;
  /** 弹窗语气;删除/封禁等不可逆操作用 destructive(默认) */
  tone?: 'default' | 'destructive';
  /** 受控模式下可不传(不渲染触发器,弹窗由外部状态驱动) */
  children?: (ctx: { pending: boolean; onClick: (e: MouseEvent) => void }) => ReactNode;
}) {
  const tUi = useTranslations('ui');
  const [innerOpen, setInnerOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const notify = useActionResult();
  const dialogOpen = openProp ?? innerOpen;
  const setDialogOpen = onOpenChange ?? setInnerOpen;

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
      {children ? children({ pending, onClick }) : null}
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
