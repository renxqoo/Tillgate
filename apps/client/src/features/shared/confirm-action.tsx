'use client';

import { useState, type MouseEvent, type ReactNode } from 'react';

import { actionResult } from './action-result';


/**
 * confirm → pending → server action → toast 的统一封装（render-prop 拿
 * pending/onClick，不额外渲染 DOM 包裹层；不传 confirm 则跳过确认直接执行）。
 */
export function ConfirmAction({
  confirm,
  action,
  errorTitle,
  success,
  children,
}: {
  confirm?: string;
  action: () => Promise<{ error?: string }>;
  errorTitle?: string;
  success?: string;
  children: (ctx: { pending: boolean; onClick: (e: MouseEvent) => void }) => ReactNode;
}) {
  const [pending, setPending] = useState(false);

  function onClick(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (confirm !== undefined && !window.confirm(confirm)) return;
    setPending(true);
    void (async () => {
      try {
        const res = await action();
        actionResult(res, errorTitle, success);
      } finally {
        setPending(false);
      }
    })();
  }

  return <>{children({ pending, onClick })}</>;
}
