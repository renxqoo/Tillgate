'use client';

import { Loader2Icon } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Card, CardContent } from '@tillgate/ui';

/**
 * 加载态卡片：fragment 完成中（Suspense 首屏与客户端解析期共用）。
 * 与错误卡片同构（图标容器 + 标题 + 描述），仅图标为旋转 Loader。
 */
export function CallbackLoadingCard() {
  const t = useTranslations('auth');
  return (
    <Card className="shadow-sm [--card-spacing:--spacing(7)]">
      <CardContent className="flex flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">{t('completing')}</h1>
          <p className="text-sm text-muted-foreground">{t('oauthCompletingDesc')}</p>
        </div>
      </CardContent>
    </Card>
  );
}
