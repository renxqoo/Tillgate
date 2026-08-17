import Link from "next/link";
import { redirect } from "next/navigation";

import { Sparkles } from "lucide-react";

import { stripAuthParams, type SearchParamsLike } from "@ai-gateway/ui/lib/auth-url";

import { RegisterForm } from "./_components/register-form";
import { OAuthButtons, oauthOptionsFromProviders, type OAuthOption } from "../_components/oauth-buttons";
import { APP_CONFIG } from "@/config/app-config";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsLike>;
}) {
  // 注册页 URL 不承载登录信息：无合法查询参数，全部剥除并 307 到干净 URL
  const sp = await searchParams;
  const affParam = Array.isArray(sp.aff) ? sp.aff[0] : sp.aff;
  const aff = typeof affParam === 'string' && /^u[0-9a-z]+$/i.test(affParam) ? affParam : null;
  const clean = stripAuthParams("/register", sp, ["aff"]);
  if (clean) redirect(clean);
  const base = process.env.CLIENT_API_BASE ?? "http://localhost:8791";
  let oauthOptions: OAuthOption[] = [];
  let registerEnabled = true;
  let captchaSiteKey: string | null = null;
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
  // 注册能力发现（开关 + 人机验证）：后端配置是单一真相。探测失败按开启渲染，
  // 由提交时的 403 兜底（不因网络抖动误显「注册已关闭」）。
  try {
    const res = await fetch(`${base}/api/auth/register/capabilities`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as { enabled?: boolean; captchaSiteKey?: string | null };
    registerEnabled = body.enabled !== false;
    captchaSiteKey = registerEnabled ? (body.captchaSiteKey ?? null) : null;
  } catch {
    registerEnabled = true;
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
            {registerEnabled ? (
              <RegisterForm oauthOptions={oauthOptions} captchaSiteKey={captchaSiteKey} affCode={aff} />
            ) : (
              <div className="rounded-xl border bg-card p-6 text-center">
                <h1 className="text-lg font-semibold">注册暂未开放</h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  邮箱注册当前已关闭。已有账号可直接登录，或使用下方第三方登录方式。
                </p>
                <Link
                  href="/login"
                  className="mt-4 inline-block text-sm text-primary underline-offset-2 hover:underline"
                >
                  去登录 →
                </Link>
                <div className="mt-4">
                  <OAuthButtons options={oauthOptions} />
                </div>
              </div>
            )}
            {registerEnabled && (
              <p className="mt-4 text-center text-sm text-muted-foreground">
                已有账号？
                <Link href="/login" className="ml-1 text-foreground hover:underline">
                  直接登录
                </Link>
              </p>
            )}
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
