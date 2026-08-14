import type { MeInfo } from "@ai-gateway/api-client";
import { getMe } from "@ai-gateway/api-client";
import { redirect } from "next/navigation";

import type { SidebarUser } from "@/components/shell/sidebar/app-sidebar";

export function userFromMe(me: MeInfo): SidebarUser {
  return {
    name: me.displayName || me.subject,
    email: me.email ?? "",
    avatar: "",
  };
}

/**
 * 客户端 dashboard 必须登录才能访问。
 *   - 调 admin-api /api/me 成功 → 用真实数据
 *   - admin-api 不可达 / dev mock 模式 (DEV_FAKE_ME=1) → 用示例数据
 *   - 401 → redirect('/login')
 *
 * 设置环境变量 `DEV_FAKE_ME=1` 可跳过 admin-api 调用（截图/演示用）。
 */
export async function requireMe(): Promise<MeInfo> {
  if (process.env.DEV_FAKE_ME === "1") {
    return {
      id: 1,
      subject: "demo_user",
      email: "demo@studio-admin.dev",
      displayName: "演示账号",
      rateCardId: 1,
      rateCardName: "标准版 ×1.0",
      balance: "4321.50",
      status: 0,
      isEnterprise: false,
      rpmLimit: 2000,
      tpmLimit: 1000000,
      lastLoginAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
  }
  const me = await getMe();
  if (!me) redirect("/login");
  return me as MeInfo;
}
