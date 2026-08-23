import { redirect } from 'next/navigation';

import { ScanEye } from 'lucide-react';

import { stripAuthParams, type SearchParamsLike } from '@/lib/auth-url';

import { LoginForm } from '@/features/auth/login-form';
import { LandingLocaleToggle } from '@/components/landing/locale-toggle';

/**
 * 管理员登录页（chat.z.ai/auth 风格：居中卡片 + logo + 标题 + 表单，黑白配色）。
 * 登录页 URL 不承载登录信息（email/password 等凭证不留地址栏与浏览器历史）：
 * 无合法查询参数，带参即 307 到干净 /login。
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const sp = await searchParams;
  const clean = stripAuthParams('/login', sp, []);
  if (clean) redirect(clean);
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-background px-4 py-10 text-foreground antialiased">
      {/* 语言切换:锚定右上角,登录前也可换语言 */}
      <div className="absolute right-6 top-6 z-10">
        <LandingLocaleToggle />
      </div>

      <div className="flex w-full max-w-[350px] flex-col items-center gap-8">
        <div className="flex flex-col items-center gap-3">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <ScanEye className="size-8" />
          </span>
          <span className="text-xl font-semibold tracking-tight">TokenLens</span>
        </div>

        <div className="w-full">
          <LoginForm />
        </div>

        <p className="text-sm text-muted-foreground">© 2026 TokenLens · MIT License</p>
      </div>
    </main>
  );
}
