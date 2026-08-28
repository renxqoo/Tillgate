import { redirect } from 'next/navigation';

import { ScanEye } from 'lucide-react';

import { stripAuthParams, type SearchParamsLike } from '@/lib/auth-url';

import { ResetPasswordForm } from '@/features/auth/reset-password-form';
import { LandingLocaleToggle } from '@/components/landing/locale-toggle';

/**
 * 设置初始密码页（新建管理员邀请邮件的一次性链接打开;token 在查询参数）。
 * 与登录页同款版式;URL 白名单只留 token,其余参数剥除 307 到干净地址
 * （凭证不留地址栏外的噪音——与 /login 同口径）。短于 20 字符视为缺失。
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  const clean = stripAuthParams('/reset-password', sp, ['token']);
  if (clean) redirect(clean);
  const tokenRaw = Array.isArray(sp.token) ? sp.token[0] : sp.token;
  const token = typeof tokenRaw === 'string' && tokenRaw.length >= 20 ? tokenRaw : null;
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
      {/* 语言切换:锚定右上角,激活前也可换语言 */}
      <div className="absolute right-6 top-6 z-10">
        <LandingLocaleToggle />
      </div>

      <div className="flex w-full max-w-[370px] flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <ScanEye className="size-8" />
          </span>
          <span className="text-xl font-semibold tracking-tight">Tillgate</span>
        </div>

        <div className="w-full">
          <ResetPasswordForm token={token} />
        </div>

        <p className="text-sm text-muted-foreground">© 2026 Tillgate · MIT License</p>
      </div>
    </main>
  );
}
