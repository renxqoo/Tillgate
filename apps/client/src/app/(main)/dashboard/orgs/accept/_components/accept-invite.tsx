"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Building2, Loader2Icon } from "lucide-react";

import { Button } from "@ai-gateway/ui/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ai-gateway/ui/components/ui/card";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

export function AcceptInvite({ token }: { token: string }) {
  const router = useRouter();
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();
  const notify = useActionResult();

  if (!token) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">邀请链接缺少 token。</CardContent>
      </Card>
    );
  }

  return (
    <div className="@container/main flex flex-col gap-4 md:gap-6">
      <div className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Building2 className="size-5 text-muted-foreground" />
          接受组织邀请
        </h1>
        <p className="text-sm text-muted-foreground">确认加入该组织？加入后可用组织的套餐额度建 Key。</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">加入组织</CardTitle>
          <CardDescription>需已登录，且登录账号邮箱与邀请邮箱一致。</CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-2">
              <p className="text-sm text-emerald-600">已加入组织。</p>
              <Button onClick={() => router.push("/dashboard/orgs")}>前往组织页</Button>
            </div>
          ) : (
            <Button
              disabled={pending}
              onClick={() =>
                startTransition(async () => {
                  const { acceptInviteAction } = await import("../../actions");
                  const res = await acceptInviteAction(token);
                  if (notify(res, "接受失败", "已加入组织")) setDone(true);
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />}接受邀请
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
