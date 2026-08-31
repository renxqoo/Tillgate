'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CircleSlash,
  CloudOff,
  KeyRound,
  TriangleAlert,
  UserX,
  type LucideIcon,
} from 'lucide-react';

import { Button, Card, CardContent, cn } from '@tillgate/ui';

import {
  oauthErrorCopy,
  type OAuthErrorCopy,
  type OAuthErrorKind,
} from '@/features/auth/oauth-error';
import { parseOAuthFragment } from '@/features/auth/oauth-fragment';
import { isNextRedirect } from '@/features/auth/next-redirect';
import { completeOAuthAction } from '@/server/actions/oauth';

import { CallbackLoadingCard } from './callback-loading-card';
import { CallbackShell } from './callback-shell';

/** 失败视图：文案已在取值点解析为字符串（固定 i18n 文案，不含外部输入） */
interface FailureView {
  kind: OAuthErrorKind;
  title: string;
  description: string;
}

/** 错误级别：语义色调分档（warning=瞬时/可重试，neutral=策略性，destructive=失败） */
type OAuthErrorLevel = 'warning' | 'neutral' | 'destructive';

/** 错误级别 → 语义色调（与 @tillgate/ui StatusPill 同款色板，暗色模式随 token） */
const LEVEL_TONE: Record<OAuthErrorLevel, string> = {
  warning: 'bg-warning/15 text-warning-foreground',
  neutral: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive/10 text-destructive dark:bg-destructive/20',
};

/** 图标随错误类别；色调只由级别决定（同级别可换图标，色板不随码变化） */
const KIND_PRESENTATION: Record<OAuthErrorKind, { level: OAuthErrorLevel; Icon: LucideIcon }> = {
  service: { level: 'warning', Icon: CloudOff },
  state: { level: 'warning', Icon: KeyRound },
  account: { level: 'destructive', Icon: UserX },
  registerClosed: { level: 'neutral', Icon: CircleSlash },
  generic: { level: 'destructive', Icon: TriangleAlert },
};

/** 白名单结构化文案 → 渲染视图（title/description 就地取自 messages） */
function toFailureView(copy: OAuthErrorCopy, t: (key: string) => string): FailureView {
  return { kind: copy.kind, title: t(copy.titleKey), description: t(copy.descKey) };
}

export function CallbackInner() {
  const params = useSearchParams();
  const t = useTranslations('auth');
  // 客户端半程失败描述（noToken/fetch 固定文案）；命名带 Desc 后缀避免与 catch 形参混淆
  const [clientFailureDesc, setClientFailureDesc] = useState<string | null>(null);
  const handled = useRef(false);
  // 服务端 302 回传的失败码：渲染期经白名单映射为结构化文案（无码 = 正常 fragment 完成路径）
  const redirectError = params.get('oauth_error');
  const redirectView: FailureView | null =
    redirectError == null ? null : toFailureView(oauthErrorCopy(redirectError), t);
  const view: FailureView | null =
    redirectView ??
    (clientFailureDesc == null
      ? null
      : {
          kind: 'generic',
          title: t('oauthErrorGenericTitle'),
          description: clientFailureDesc,
        });
  const { level, Icon } = view != null ? KIND_PRESENTATION[view.kind] : KIND_PRESENTATION.generic;

  useEffect(() => {
    if (redirectError != null || handled.current) return;
    handled.current = true;
    const { token, next } = parseOAuthFragment(window.location.hash);
    if (!token) {
      // eslint-disable-next-line react/set-state-in-effect -- URL fragment 属浏览器态外部输入，只能在挂载 effect 中校验并一次性上抛错误文案
      setClientFailureDesc(t('noTokenRetry'));
      return;
    }
    // action 成功即 redirect：redirect() 在 Server Action 内部以 NEXT_REDIRECT
    // digest 异常表达，手动调用形态下该 rejection 会先到达这里——它是成功信号
    // （cookie 已写、导航由框架接手），只有非 NEXT_REDIRECT 才是真失败
    void completeOAuthAction(token, next ?? params.get('next')).catch((error: unknown) => {
      if (isNextRedirect(error)) return;
      setClientFailureDesc(t('fetchError'));
    });
  }, [params, redirectError, t]);

  return (
    <CallbackShell>
      {view != null ? (
        <Card className="shadow-sm [--card-spacing:--spacing(7)]">
          <CardContent className="flex flex-col items-center gap-5 text-center">
            <span
              className={cn(
                'flex size-12 items-center justify-center rounded-xl',
                LEVEL_TONE[level],
              )}
            >
              <Icon className="size-6" aria-hidden="true" />
            </span>
            <div className="space-y-1.5">
              <h1 className="text-lg font-semibold tracking-tight">{view.title}</h1>
              <p className="text-sm text-muted-foreground">{view.description}</p>
            </div>
            <Button render={<Link href="/login" />} className="h-10 w-full">
              {t('goLoginNow')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('oauthRetryHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <CallbackLoadingCard />
      )}
    </CallbackShell>
  );
}
