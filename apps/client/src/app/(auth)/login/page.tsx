import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Sparkles } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { LoginForm } from '@/features/auth/login-form';
import { oauthOptionsFromProviders, type OAuthOption } from '@/features/auth/oauth-options';
import { APP_CONFIG } from '@/config/app-config';
import { fetchOAuthProviders } from '@/server/discovery';

interface PageProps {
  searchParams: Promise<SearchParamsLike>;
}

export default async function LoginPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 登录页 URL 不承载登录信息：白名单（next）外的查询参数一律剥除并 307 到
  // 干净 URL——凭证/令牌不留地址栏与浏览器历史（白名单制：新参数须显式登记）
  const clean = stripAuthParams('/login', sp, ['next']);
  if (clean) redirect(clean);
  const nextRaw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = typeof nextRaw === 'string' && nextRaw.startsWith('/') ? nextRaw : null;
  const providers = await fetchOAuthProviders();
  const oauthOptions: OAuthOption[] = next
    ? oauthOptionsFromProviders(providers).map((o) => ({
        ...o,
        url: `${o.url}?next=${encodeURIComponent(next)}`,
      }))
    : oauthOptionsFromProviders(providers);
  const t = await getTranslations('auth');
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* 左侧：登录表单 */}
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center gap-2 self-start">
          <Sparkles className="size-5 text-primary" />
          <span className="font-semibold text-base">{APP_CONFIG.name}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <LoginForm next={next} oauthOptions={oauthOptions} />
          </div>
        </div>
      </div>

      {/* 右侧：渐变 hero */}
      <div className="relative hidden lg:flex lg:flex-col lg:items-center lg:justify-center bg-muted/30 p-10">
        <div className="max-w-md space-y-4 text-center">
          <div className="inline-flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-7" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">{t('heroTitle')}</h2>
          <p className="text-muted-foreground">{t('heroDesc')}</p>
          <p className="text-xs text-muted-foreground pt-4">
            {t('needHelp')}
            <Link href="#" className="ml-1 text-foreground hover:underline">
              {t('contactSupport')}
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
