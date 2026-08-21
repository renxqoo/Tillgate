import Link from "next/link";
import { redirect } from "next/navigation";

import { Sparkles } from "lucide-react";

import { stripAuthParams, type SearchParamsLike } from "@ai-gateway/ui/lib/auth-url";

import { LoginForm } from "./_components/login-form";
import { oauthOptionsFromProviders, type OAuthOption } from "../_components/oauth-buttons";
import { APP_CONFIG } from "@/config/app-config";

interface PageProps {
  searchParams: Promise<SearchParamsLike>;
}

/** client-api 已配置的第三方登录（不可达/未配置 = 无按钮） */
async function fetchOAuthOptions(next: string | null): Promise<OAuthOption[]> {
  const base = process.env.CLIENT_API_BASE!;
  try {
    const res = await fetch(`${base}/v1/oauth/providers`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    const body = (await res.json()) as { providers?: string[] };
    const options = oauthOptionsFromProviders(body.providers ?? []);
    return next ? options.map((o) => ({ ...o, url: `${o.url}?next=${encodeURIComponent(next)}` })) : options;
  } catch {
    return [];
  }
}

export default async function LoginPage({ searchParams }: PageProps) {
  const sp = await searchParams;
  // 登录页 URL 不承载登录信息：白名单（next）外的查询参数一律剥除并 307 到
  // 干净 URL——凭证/令牌不留地址栏与浏览器历史（白名单制：新参数须显式登记）
  const clean = stripAuthParams("/login", sp, ["next"]);
  if (clean) redirect(clean);
  const nextRaw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  const next = typeof nextRaw === "string" && nextRaw.startsWith("/") ? nextRaw : null;
  const oauthOptions = await fetchOAuthOptions(next);
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
          <h2 className="text-2xl font-semibold tracking-tight">统一接入多家大模型</h2>
          <p className="text-muted-foreground">
            余额统一、按量计费、RPM / TPM 实时生效。一行代码调用 OpenAI / Anthropic / DeepSeek 等多家供应商。
          </p>
          <p className="text-xs text-muted-foreground pt-4">
            遇到问题？
            <Link href="#" className="ml-1 text-foreground hover:underline">
              联系客服
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
