/**
 * 管理后台服务端语言策略(server-only,client 组件禁引)。
 *
 * 链路:NEXT_LOCALE cookie(语言切换器显式选择)→ 中文。
 * 不跟随浏览器 Accept-Language——管理台是中文运营团队的内部面,英文仅经
 * 切换器主动选择;与 src/config/i18n-request.ts 同源,BFF 出口 accept-language
 * 注入同一策略,保证 API 错误 message 与界面语言一致。
 */
import { resolveLocale, type LocaleResolution } from '@tillgate/api-client/next';

export const ADMIN_LOCALE_RESOLUTION: LocaleResolution = {
  honorAcceptLanguage: false,
  fallback: 'zh',
};

/** 当前请求的管理台语言(cookie → zh);入参来自 next/headers 读出的原始值 */
export function adminLocale(
  cookieValue: string | null | undefined,
  acceptLanguage: string | null | undefined,
) {
  return resolveLocale(cookieValue, acceptLanguage, ADMIN_LOCALE_RESOLUTION);
}
