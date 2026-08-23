import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';

import { stripAuthParams, type SearchParamsLike } from '@/features/auth/auth-url';
import { LandingLocaleToggle } from '@/features/auth/landing-locale-toggle';
import { ForgotForm } from '@/features/auth/forgot-form';
import { APP_CONFIG } from '@/config/app-config';

/** 找回密码页(公开;两步制——发起 → 邮箱验证码 → 重置即登录) */
export default async function ForgotPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  const clean = stripAuthParams('/forgot', sp, []);
  if (clean) redirect(clean);
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
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
          <ForgotForm />
        </div>
        <p className="text-sm text-muted-foreground">© 2026 TokenLens · MIT License</p>
      </div>
    </main>
  );
}
