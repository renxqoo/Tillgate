import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';
import { OAuthButtons } from '@/features/auth/oauth-buttons';
import { oauthOptionsFromProviders } from '@/features/auth/oauth-options';
import { RegisterForm } from '@/features/auth/register-form';
import { APP_CONFIG } from '@/config/app-config';
import { fetchAuthCapabilities, fetchOAuthProviders } from '@/server/discovery';

/** 注册页(与登录页同款居中单卡布局——logo 块 + 卡片 + 页脚,语言切换锚定右上角) */
export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  // 注册页 URL 不承载登录信息：白名单（aff 邀请码）外的查询参数剥除并 307 到干净 URL
  const sp = await searchParams;
  const affParam = Array.isArray(sp.aff) ? sp.aff[0] : sp.aff;
  const aff = typeof affParam === 'string' && /^u[0-9a-z]+$/i.test(affParam) ? affParam : null;
  const clean = stripAuthParams('/register', sp, ['aff']);
  if (clean) redirect(clean);

  const [providers, capabilities] = await Promise.all([
    fetchOAuthProviders(),
    fetchAuthCapabilities(),
  ]);
  const oauthOptions = oauthOptionsFromProviders(providers);
  // 后端配置是单一真相（registerEnabled/captchaSiteKey）；探测失败按开启渲染，
  // 由提交时的 403 兜底（B20 取舍：不因网络抖动误显「注册已关闭」）
  const registerEnabled = capabilities.registerEnabled;
  const captchaSiteKey = registerEnabled ? capabilities.captchaSiteKey : null;
  const t = await getTranslations('auth');
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
      {/* 语言切换：锚定右上角，登录前也可换语言 */}
      <div className="absolute right-6 top-6 z-10">
        <LandingLocaleToggle />
      </div>

      <div className="flex w-full max-w-[370px] flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-8" />
          </span>
          <span className="text-xl font-semibold tracking-tight">{APP_CONFIG.name}</span>
        </div>

        <div className="w-full">
          {registerEnabled ? (
            <RegisterForm
              oauthOptions={oauthOptions}
              captchaSiteKey={captchaSiteKey}
              affCode={aff}
            />
          ) : (
            <div className="rounded-xl border bg-card p-6 text-center">
              <h1 className="text-lg font-semibold">{t('registerClosedTitle')}</h1>
              <p className="mt-2 text-sm text-muted-foreground">{t('registerClosedDesc')}</p>
              <Link
                href="/login"
                className="mt-4 inline-block text-sm text-primary underline-offset-2 hover:underline"
              >
                {t('goToLogin')}
              </Link>
              <div className="mt-4">
                <OAuthButtons options={oauthOptions} />
              </div>
            </div>
          )}
          {registerEnabled && (
            <p className="mt-4 text-center text-sm text-muted-foreground">
              {t('hasAccount')}
              <Link
                href="/login"
                className="ml-1 text-foreground underline-offset-2 hover:underline"
              >
                {t('loginDirectly')}
              </Link>
            </p>
          )}
        </div>

        <p className="text-sm text-muted-foreground">© 2026 Tillgate · MIT License</p>
      </div>
    </main>
  );
}
