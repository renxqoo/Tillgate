'use client';

/**
 * OAuth 回调落地页：会话 token 放 URL fragment（#token=…，不进服务端
 * 日志/Referer）——本页客户端 JS 提取后经 Server Action 存入 BFF 会话 cookie，
 * 再清掉地址栏 fragment 跳转目标页。
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { completeOAuthAction } from './actions';

function CallbackInner() {
  const router = useRouter();
  const params = useSearchParams();
  const t = useTranslations('auth');
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      setError(t('noTokenRetry'));
      return;
    }
    const next = params.get('next');
    void (async () => {
      const result = await completeOAuthAction(token, next);
      if (result?.error) {
        setError(result.error);
        return;
      }
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
    })();
  }, [params, router, t]);

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
