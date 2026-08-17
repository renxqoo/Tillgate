import Link from "next/link";

import { ArrowRight } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Sparkles } from "lucide-react";

import { APP_CONFIG } from "@/config/app-config";

export default function Landing() {
  return (
    <main className="@container/main mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center gap-8 px-4 py-16">
      <div className="space-y-2 text-center">
        <div className="flex items-center justify-center gap-2">
          <Sparkles className="size-7 text-primary" />
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">{APP_CONFIG.name}</h1>
        </div>
        <p className="text-muted-foreground">多供应商 LLM API 中转，统一余额、统一接入</p>
      </div>

      {/* Slot 一次只能接收一个子元素——两个链接必须是两颗独立按钮 */}
      <div className="flex items-center gap-4">
        <Button asChild variant="link" size="lg" className="text-sm text-muted-foreground underline">
          <Link href="/pricing">模型定价</Link>
        </Button>
        <Button asChild size="lg">
          <Link href="/dashboard">
            进入用户面板 <ArrowRight />
          </Link>
        </Button>
      </div>
    </main>
  );
}
