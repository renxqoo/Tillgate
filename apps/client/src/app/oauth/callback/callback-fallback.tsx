'use client';

import { CallbackLoadingCard } from './callback-loading-card';
import { CallbackShell } from './callback-shell';

/** Suspense 兜底：useSearchParams 就绪前的首屏，与加载态同卡同壳 */
export function CallbackFallback() {
  return (
    <CallbackShell>
      <CallbackLoadingCard />
    </CallbackShell>
  );
}
