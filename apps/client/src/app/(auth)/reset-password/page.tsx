import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';
import { ResetPasswordForm } from '@/features/auth/reset-password-form';
import { APP_CONFIG } from '@/config/app-config';

/** 重置密码页(邮件一次性链接打开;token 在查询参数,页面不缓存) */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  // URL 白名单只留 token;其余参数剥除 307 到干净地址(凭证不留地址栏外的噪音)
  const clean = stripAuthParams('/reset-password', sp, ['token']);
  if (clean) redirect(clean);
  const tokenRaw = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  const token = typeof tokenRaw === 'string' && tokenRaw.length >= 20 ? tokenRaw : null;
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
      <div className="absolute right-6 top-6 z-10">
        <LandingLocaleToggle />
      </div>
      <div className="flex w-full max-w-[350px] flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Sparkles className="size-8" />
          </span>
          <span className="text-xl font-semibold tracking-tight">{APP_CONFIG.name}</span>
        </div>
        <div className="w-full">
          <ResetPasswordForm token={token} />
        </div>
        <p className="text-sm text-muted-foreground">© 2026 TokenLens · MIT License</p>
      </div>
    </main>
  );
}
