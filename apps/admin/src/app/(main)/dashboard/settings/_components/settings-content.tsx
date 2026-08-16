"use client";

import { useState, useTransition } from "react";

import { Loader2Icon, ShieldCheckIcon } from "lucide-react";

import type { AdminMeInfo } from "@ai-gateway/api-client";
import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";

import { setTwoFactorAction } from "@/lib/server-actions/auth";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

export function SettingsContent({ me, error }: { me: AdminMeInfo | null; error: string | null }) {
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();
  const [enabled, setEnabled] = useState(Boolean(me?.twoFactorEnabled));

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">{error}</CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheckIcon className="size-4" /> 邮箱验证码二次登录
        </CardTitle>
        <CardDescription>
          开启后，输入正确密码还需邮箱收到的 6 位验证码（5 分钟有效）才能登录。管理员：{me?.email ?? "—"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3">
          <Button
            variant={enabled ? "destructive" : "default"}
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const next = !enabled;
                const res = await setTwoFactorAction(next);
                if (notify(res ?? {}, "操作失败", next ? "已开启邮箱验证码登录" : "已关闭邮箱验证码登录")) setEnabled(next);
              })
            }
          >
            {pending && <Loader2Icon className="animate-spin" />}
            {enabled ? "关闭" : "开启"}
          </Button>
          <span className="text-sm text-muted-foreground">
            当前状态：<span className={enabled ? "text-green-600" : ""}>{enabled ? "已开启" : "未开启"}</span>
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          需要服务端已配置 SMTP（个人邮箱开 SMTP 授权码即可）。未配置时开启会被拒绝——绝不静默降级为单密码。
        </p>
      </CardContent>
    </Card>
  );
}
