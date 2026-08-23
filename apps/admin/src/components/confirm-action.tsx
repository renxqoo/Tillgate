'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';

import { useActionResult } from './action-toast';

/**
 * confirm → pending → server action → toast 的统一封装。
 *
 * 替换各表格行操作按钮里的样板：
 *
 *   onClick={async () => {
 *     if (!confirm(`确定删除渠道 ${name}？`)) return;
 *     setPending(true);
 *     const { deleteChannelAction } = await import("../actions");
 *     const res = await deleteChannelAction(id);
 *     setPending(false);
 *     if (res.error) toast.error(res.error);
 *     else toast.success("已删除");
 *   }}
 *
 * 用法（render-prop 拿 pending / onClick，不额外渲染 DOM 包裹层）：
 *
 *   <ConfirmAction
 *     confirm={`确定删除渠道 ${channel.name}？`}
 *     action={async () => (await import("../actions")).deleteChannelAction(channel.id)}
 *     success="已删除"
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
  children,
}: {
  /** window.confirm 文案；不传则跳过确认直接执行 */
  confirm?: string;
  /** 待执行的 server action（返回 { error?: string }） */
  action: () => Promise<{ error?: string }>;
  /** 失败 toast 标题；缺省时直接 toast.error(res.error) */
  errorTitle?: string;
  /** 成功 toast 文案 */
  success?: string;
  children: (ctx: { pending: boolean; onClick: (e: MouseEvent) => void }) => ReactNode;
}) {
  const [pending, setPending] = useState(false);
  const notify = useActionResult();

  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (confirm !== undefined && !window.confirm(confirm)) return;
    setPending(true);
    void (async () => {
      try {
        const res = await action();
        notify(res, errorTitle, success);
      } finally {
        setPending(false);
      }
    })();
  }

  return <>{children({ pending, onClick })}</>;
}
