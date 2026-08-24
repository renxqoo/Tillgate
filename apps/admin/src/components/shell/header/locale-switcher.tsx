'use client';

import { Button } from '@tillgate/ui';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { LanguagesIcon } from 'lucide-react';

import { setValueToCookie } from '@/server/cookies-actions';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '@/lib/locale';

/**
 * 语言切换：写 NEXT_LOCALE cookie（server-cookie，SSR 直读）后 router.refresh()
 * 重渲染当前路由——服务端按新语言出全量 HTML，无客户端闪变。
 * 双态切换 en ↔ zh；当前语言以文字标签呈现（EN / 中）。
 */
export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations('ui');
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function toggle() {
    const next: Locale = locale === 'zh' ? 'en' : 'zh';
    startTransition(async () => {
      await setValueToCookie(LOCALE_COOKIE, next, { maxAge: LOCALE_COOKIE_MAX_AGE });
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
