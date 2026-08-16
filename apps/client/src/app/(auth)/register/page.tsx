import Link from "next/link";
import { redirect } from "next/navigation";

import { Sparkles } from "lucide-react";

import { stripAuthParams, type SearchParamsLike } from "@ai-gateway/ui/lib/auth-url";

import { RegisterForm } from "./_components/register-form";
import { oauthOptionsFromProviders, type OAuthOption } from "../_components/oauth-buttons";
import { APP_CONFIG } from "@/config/app-config";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  // 注册页 URL 不承载登录信息：无合法查询参数，全部剥除并 307 到干净 URL
  const sp = await searchParams;
  const clean = stripAuthParams("/register", sp, []);
  if (clean) redirect(clean);
  const base = process.env.CLIENT_API_BASE ?? "http://localhost:8791";
  let oauthOptions: OAuthOption[] = [];
  try {
    const res = await fetch(`${base}/api/auth/oauth/providers`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as { providers?: string[] };
    oauthOptions = oauthOptionsFromProviders(body.providers ?? [], base);
  } catch {
    oauthOptions = [];
  }
  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* 左侧：注册表单 */}
      <div className="flex flex-col gap-4 p-6 md:p-10">
        <div className="flex items-center gap-2 self-start">
          <Sparkles className="size-5 text-primary" />
          <span className="font-semibold text-base">{APP_CONFIG.name}</span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="w-full max-w-sm">
            <RegisterForm oauthOptions={oauthOptions} />
            <p className="mt-4 text-center text-sm text-muted-foreground">
              已有账号？
              <Link href="/login" className="ml-1 text-foreground hover:underline">
                直接登录
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* 右侧：渐变 hero（与登录页一致） */}
      <div className="relative hidden lg:flex lg:flex-col lg:items-center lg:justify-center bg-muted/30 p-10">
        <div className="max-w-md space-y-4 text-center">
          <div className="inline-flex size-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Sparkles className="size-7" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">统一接入多家大模型</h2>
          <p className="text-muted-foreground">
            余额统一、按量计费、RPM / TPM 实时生效。一行代码调用 OpenAI / Anthropic / DeepSeek 等多家供应商。
          </p>
        </div>
      </div>
    </div>
  );
}
