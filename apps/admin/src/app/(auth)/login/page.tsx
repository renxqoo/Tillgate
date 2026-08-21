import { redirect } from "next/navigation";

import { ShieldCheck } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { stripAuthParams, type SearchParamsLike } from "@ai-gateway/ui/lib/auth-url";

import { LoginForm } from "./_components/login-form";
import { APP_CONFIG } from "@/config/app-config";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  const t = await getTranslations("auth");
  // 登录页 URL 不承载登录信息（email/password 等凭证不留地址栏与浏览器历史）：
  // 管理端登录页无合法查询参数，带参即 307 到干净 /login
  const sp = await searchParams;
  const clean = stripAuthParams("/login", sp, []);
  if (clean) redirect(clean);
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center gap-2 self-start">
          <ShieldCheck className="size-5 text-primary" />
          <span className="font-semibold text-base">{t("brandTitle", { name: APP_CONFIG.name })}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <LoginForm />
          </div>
        </div>
      </div>

      <div className="relative hidden lg:flex lg:flex-col lg:items-center lg:justify-center bg-muted/30 p-10">
        <div className="max-w-md space-y-4 text-center">
          <div className="inline-flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <ShieldCheck className="size-7" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">{t("heroTitle")}</h2>
          <p className="text-muted-foreground">{t("heroDescription")}</p>
        </div>
      </div>
    </div>
  );
}
