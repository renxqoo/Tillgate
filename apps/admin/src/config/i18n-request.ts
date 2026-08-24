import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE } from '@tillgate/api-client/next';

import { adminLocale } from '@/server/admin-locale';

/**
 * 无路由模式(纯 cookie,不改 URL):语言解析链 cookie NEXT_LOCALE → 中文。
 * 不跟随 Accept-Language(管理台内部面策略,见 server/admin-locale.ts);
 * SSR 全量按此渲染,无客户端闪变。
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = adminLocale(
    cookieStore.get(LOCALE_COOKIE)?.value,
    headerStore.get('accept-language'),
  );
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
