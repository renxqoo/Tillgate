import Link from "next/link";

import { Sparkles } from "lucide-react";

import { LoginForm } from "./_components/login-form";
import { APP_CONFIG } from "@/config/app-config";

export default function LoginPage() {
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
            <LoginForm />
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
