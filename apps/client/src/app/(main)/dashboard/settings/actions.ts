"use server";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function changePasswordAction(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ error?: string; code?: string }> {
  if (!input.oldPassword) return { error: "请输入当前密码" };
  if (input.newPassword.length < 8) return { error: "新密码至少 8 位" };
  if (input.newPassword.length > 128) return { error: "新密码最多 128 位" };
  try {
    await apiFetch("/api/auth/password", {
      method: "POST",
      body: { oldPassword: input.oldPassword, newPassword: input.newPassword },
    });
    return {};
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message, code: e.code };
    }
    return { error: "修改失败，请重试" };
  }
}
