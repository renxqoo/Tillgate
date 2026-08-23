'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { GlobeIcon } from 'lucide-react';

import { setValueToCookie } from '@/server/cookies-actions';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, type Locale } from '@/lib/locale';

/**
 * 落地页语言切换：与 shell 头部的 LocaleSwitcher 同机制（写 NEXT_LOCALE cookie 后
 * router.refresh() 全量重渲染），外观对齐 zcode.z.ai 的 EN/中 圆角胶囊。
 */
export function LandingLocaleToggle() {
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
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-label={t('switchLocale')}
      className="inline-flex min-w-[84px] shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border border-border bg-background/80 px-3 py-1.5 text-sm font-normal text-muted-foreground backdrop-blur transition hover:text-foreground disabled:opacity-50"
    >
      <GlobeIcon className="size-4 text-muted-foreground" />
      {locale === 'zh' ? 'EN' : '中'}
    </button>
  );
}
