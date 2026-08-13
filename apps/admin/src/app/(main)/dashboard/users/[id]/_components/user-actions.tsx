"use client";

import { AdjustDialog, GiftDialog, PasswordDialog } from "../../_components/user-dialogs";
import type { UserRow } from "../../types";

/**
 * 用户详情页操作按钮组（弹窗实现在共享组件 user-dialogs）。
 */
export function UserActions({ user }: { readonly user: UserRow }) {
  return (
    <div className="flex items-center gap-2">
      <AdjustDialog user={user} />
      <GiftDialog user={user} />
      <PasswordDialog user={user} />
    </div>
  );
}
