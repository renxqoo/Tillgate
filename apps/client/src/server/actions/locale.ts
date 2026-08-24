'use server';

/**
 * 语言切换：写 NEXT_LOCALE cookie（1 年）后由调用方 router.refresh() 全量重渲染
 * （v1 由 ui 包 server action 承担；P7 ui 禁服务端依赖后归 app——D1）。
 */
import { cookies } from 'next/headers';

import { isLocale, LOCALE_COOKIE } from '@tillgate/api-client/next';

/** cookie 寿命与 api-client locale.ts 解析链同口径（1 年） */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export async function setLocaleAction(locale: string): Promise<void> {
  if (!isLocale(locale)) return;
  const jar = await cookies();
  jar.set(LOCALE_COOKIE, locale, { path: '/', maxAge: LOCALE_COOKIE_MAX_AGE });
}
