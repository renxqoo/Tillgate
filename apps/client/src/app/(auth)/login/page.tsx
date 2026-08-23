import { redirect } from 'next/navigation';

import { Sparkles } from 'lucide-react';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';
import { LoginForm } from '@/features/auth/login-form';
import { oauthOptionsFromProviders, type OAuthOption } from '@/features/auth/oauth-options';
import { APP_CONFIG } from '@/config/app-config';
import { fetchOAuthProviders } from '@/server/discovery';

/**
 * 用户端登录页（与管理端同布局范式：居中卡片 + logo + 标题 + 表单，黑白配色）。
 * 登录页 URL 不承载登录信息（email/password 等凭证不留地址栏与浏览器历史）：
 * 白名单（next）外的查询参数一律剥除并 307 到干净 /login。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
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
          <LoginForm next={next} oauthOptions={oauthOptions} />
        </div>

        <p className="text-sm text-muted-foreground">© 2026 TokenLens · MIT License</p>
      </div>
    </main>
  );
}
