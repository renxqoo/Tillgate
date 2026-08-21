"use client";

import { useTransition } from "react";
import { BriefcaseIcon, Loader2Icon, UserIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@ai-gateway/ui/components/ui/button";

import { AdjustDialog, GiftDialog, PasswordDialog } from "../../_components/user-dialogs";
import type { AdminUserRow } from "@ai-gateway/api-client/types";
import { useActionResult } from "@ai-gateway/ui/components/action-toast";

/**
 * 用户详情页操作按钮组（弹窗实现在共享组件 user-dialogs）。
 */
export function UserActions({ user }: { readonly user: AdminUserRow }) {
  const t = useTranslations("users");
  const tc = useTranslations("common");
  const notify = useActionResult();
  const [pending, startTransition] = useTransition();

  function toggleEnterprise() {
    startTransition(async () => {
      const { setUserEnterpriseAction } = await import("../../actions");
      const res = await setUserEnterpriseAction(user.id, !user.isEnterprise);
      notify(res, tc("actionFailed"), user.isEnterprise ? t("removedEnterprise") : t("markedEnterprise"));
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
        title={user.isEnterprise ? t("removeEnterprise") : t("setEnterprise")}
        onClick={toggleEnterprise}
      >
        {pending ? (
          <Loader2Icon className="animate-spin" />
        ) : user.isEnterprise ? (
          <UserIcon />
        ) : (
          <BriefcaseIcon />
        )}
        {user.isEnterprise ? t("removeEnterprise") : t("setEnterprise")}
      </Button>
    </div>
  );
}
