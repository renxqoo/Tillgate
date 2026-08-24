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
import { isNextRedirect } from '@/features/auth/next-redirect';
import { completeOAuthAction } from '@/server/actions/oauth';

/** fragment 解析纯函数（可测）：#token=…&next=… → {token, next} */
function CallbackInner() {
  const params = useSearchParams();
  const t = useTranslations('auth');
  // 状态命名 oauthError：让 .catch 形参可按 catch-error-name 规则命名为 error 而不遮蔽
  const [oauthError, setOauthError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const { token, next } = parseOAuthFragment(window.location.hash);
    if (!token) {
      // eslint-disable-next-line react/set-state-in-effect -- URL fragment 属浏览器态外部输入，只能在挂载 effect 中校验并一次性上抛错误文案
      setOauthError(t('noTokenRetry'));
      return;
    }
    // action 成功即 redirect：redirect() 在 Server Action 内部以 NEXT_REDIRECT
    // digest 异常表达，手动调用形态下该 rejection 会先到达这里——它是成功信号
    // （cookie 已写、导航由框架接手），只有非 NEXT_REDIRECT 才是真失败
    void completeOAuthAction(token, next ?? params.get('next')).catch((error: unknown) => {
      if (isNextRedirect(error)) return;
      setOauthError(t('fetchError'));
    });
  }, [params, t]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center text-sm text-muted-foreground">
        {oauthError ? <p className="text-destructive">{oauthError}</p> : <p>{t('completing')}</p>}
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
