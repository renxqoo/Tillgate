import Link from "next/link";

import { ArrowRight, ShieldCheck } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";

import { APP_CONFIG } from "@/config/app-config";

export default function Landing() {
  return (
    <main className="@container/main mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="space-y-2 text-center">
        <div className="flex items-center justify-center gap-2">
          <ShieldCheck className="size-7 text-primary" />
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            {APP_CONFIG.name} 管理后台
          </h1>
        </div>
        <p className="text-muted-foreground">仅限受邀管理员账号登录</p>
      </div>

      <Button asChild size="lg">
        <Link href="/login">
          进入登录 <ArrowRight />
        </Link>
      </Button>
    </main>
  );
}
