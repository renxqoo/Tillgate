"use client";

import { useTransition } from "react";
import { BriefcaseIcon, Loader2Icon, UserIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@ai-gateway/ui/components/ui/button";

import { AdjustDialog, GiftDialog, PasswordDialog } from "../../_components/user-dialogs";
import type { UserRow } from "../../types";

/**
 * 用户详情页操作按钮组（弹窗实现在共享组件 user-dialogs）。
 */
export function UserActions({ user }: { readonly user: UserRow }) {
  const [pending, startTransition] = useTransition();

  function toggleEnterprise() {
    startTransition(async () => {
      const { setUserEnterpriseAction } = await import("../../actions");
      const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
      if (res.error) toast.error("操作失败", { description: res.error });
      else toast.success(user.isEnterprise ? "已取消企业" : "已设为企业");
    });
  }

  return (
    <div className="flex items-center gap-2">
      <AdjustDialog user={user} />
      <GiftDialog user={user} />
      <PasswordDialog user={user} />
      <Button
        size="sm"
        variant={user.isEnterprise ? "secondary" : "outline"}
        disabled={pending}
        title={user.isEnterprise ? "取消企业" : "设为企业"}
        onClick={toggleEnterprise}
      >
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : user.isEnterprise ? (
          <UserIcon />
        ) : (
          <BriefcaseIcon />
        )}
        {user.isEnterprise ? "取消企业" : "设为企业"}
      </Button>
    </div>
  );
}
