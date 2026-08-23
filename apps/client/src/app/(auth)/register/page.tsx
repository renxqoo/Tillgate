import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { OAuthButtons } from '@/features/auth/oauth-buttons';
import { oauthOptionsFromProviders } from '@/features/auth/oauth-options';
import { RegisterForm } from '@/features/auth/register-form';
import { APP_CONFIG } from '@/config/app-config';
import { fetchAuthCapabilities, fetchOAuthProviders } from '@/server/discovery';
import { AuthShell } from '@tokenlens/ui';

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
    <AuthShell
      brand={
        <Link href="/" className="flex items-center gap-2 font-medium">
          <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Sparkles className="size-4" />
          </span>
          {APP_CONFIG.name}
        </Link>
      }
      asideIcon={<Sparkles />}
      asideTitle={t('heroTitle')}
      asideDescription={t('heroDesc')}
    >
      {registerEnabled ? (
        <RegisterForm oauthOptions={oauthOptions} captchaSiteKey={captchaSiteKey} affCode={aff} />
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
          <Link href="/login" className="ml-1 text-foreground hover:underline">
            {t('loginDirectly')}
          </Link>
        </p>
      )}
    </AuthShell>
  );
}
