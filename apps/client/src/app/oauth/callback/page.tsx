'use client';

/**
 * OAuth 回调落地页：会话 token 放 URL fragment（#token=…，不进服务端
 * 日志/Referer）——本页客户端 JS 提取后经 Server Action 存入 BFF 会话 cookie，
 * action 内 redirect 到 next（fragment 随 replace 一并清除）。
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { parseOAuthFragment } from '@/features/auth/oauth-fragment';
import { completeOAuthAction } from '@/server/actions/oauth';

/** fragment 解析纯函数（可测）：#token=…&next=… → {token, next} */
function CallbackInner() {
  const params = useSearchParams();
  const t = useTranslations('auth');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const { token, next } = parseOAuthFragment(window.location.hash);
    if (!token) {
      setError(t('noTokenRetry'));
      return;
    }
    // action 成功即 redirect（NEXT_REDIRECT），失败态只可能是网络层异常
    void completeOAuthAction(token, next ?? params.get('next')).catch(() =>
      setError(t('fetchError')),
    );
  }, [params, t]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center text-sm text-muted-foreground">
        {error ? <p className="text-destructive">{error}</p> : <p>{t('completing')}</p>}
      </div>
    </div>
  );
}

function CallbackFallback() {
  const t = useTranslations('auth');
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
      {t('completing')}
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<CallbackFallback />}>
      <CallbackInner />
    </Suspense>
  );
}
