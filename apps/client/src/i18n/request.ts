import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { LOCALE_COOKIE, resolveLocale } from '@tokenlens/api-client/next';

/**
 * 无路由模式（纯 cookie，不改 URL）：语言解析链 cookie NEXT_LOCALE →
 * 浏览器 Accept-Language → 默认英文。SSR 全量按此渲染，无客户端闪变。
 * 解析逻辑单源于 @tokenlens/api-client/next（locale.ts），app 不自持第二套。
 */
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get('accept-language'));
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
