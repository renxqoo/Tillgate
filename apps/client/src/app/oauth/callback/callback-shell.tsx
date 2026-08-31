'use client';

import type { ReactNode } from 'react';

/**
 * 回调页共用外壳：全屏居中 + max-w-[370px] 卡片容器（黑白极简，不带品牌
 * 标记——回调页是流程性页面，仅保留卡片本体）。Suspense fallback 与
 * CallbackInner 共用本组件，保证加载/失败两态布局完全一致（fallback 先
 * 渲染，markup 漂移会造成闪跳）。
 */
export function CallbackShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
      <div className="w-full max-w-[370px]">{children}</div>
    </main>
  );
}
