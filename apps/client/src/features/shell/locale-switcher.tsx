'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LanguagesIcon } from 'lucide-react';

import { Button } from '@tillgate/ui';
import { type Locale } from '@tillgate/api-client/next';

import { setLocaleAction } from '@/server/actions/locale';

/**
 * 语言切换：写 NEXT_LOCALE cookie 后 router.refresh() 重渲染当前路由——
 * 服务端按新语言出全量 HTML，无客户端闪变。双态切换 en ↔ zh。
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations('ui');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next: Locale = locale === 'zh' ? 'en' : 'zh';
    startTransition(async () => {
      await setLocaleAction(next);
      router.refresh();
    });
  }

  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={toggle}
      disabled={pending}
      aria-label={t('switchLocale')}
    >
      <LanguagesIcon />
      <span className="text-xs font-semibold">{locale === 'zh' ? '中' : 'EN'}</span>
    </Button>
  );
}
