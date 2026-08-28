'use client';

/**
 * OAuth 回调落地页：会话 token 放 URL fragment（#token=…，不进服务端
 * 日志/Referer）——本页客户端 JS 提取后经 Server Action 存入 BFF 会话 cookie，
 * action 内 redirect 到 next（fragment 随 replace 一并清除）。
 */
import { Suspense } from 'react';

import { CallbackFallback } from './callback-fallback';
import { CallbackInner } from './callback-inner';

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <CallbackInner />
    </Suspense>
  );
}
