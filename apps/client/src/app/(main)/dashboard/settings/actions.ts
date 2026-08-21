"use server";

import { apiFetch, ApiError, setSessionToken } from "@ai-gateway/api-client";

export async function changePasswordAction(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ error?: string; code?: string }> {
  if (!input.oldPassword) return { error: "请输入当前密码" };
  if (input.newPassword.length < 8) return { error: "新密码至少 8 位" };
  if (input.newPassword.length > 128) return { error: "新密码最多 128 位" };
  try {
    const res = await apiFetch<{ token: string }>("/v1/auth/password", {
      method: "POST",
      body: { oldPassword: input.oldPassword, newPassword: input.newPassword },
    });
    // 改密作废全部旧会话并同拍签发新 token——BFF 轮换持有
    if (res.token) await setSessionToken(res.token);
    return {};
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message, code: e.code };
    }
    return { error: "修改失败，请重试" };
  }
}

/** 修改显示名称（1-32 字符，服务端二次校验） */
export async function updateDisplayNameAction(input: {
  displayName: string;
}): Promise<{ error?: string; displayName?: string }> {
  const name = input.displayName.trim();
  if (!name) return { error: "请输入显示名称" };
  if (name.length > 32) return { error: "最多 32 个字符" };
  try {
    const res = await apiFetch("/v1/me/display-name", {
      method: "PATCH",
      body: { displayName: name },
    });
    return { displayName: (res as { displayName: string }).displayName };
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message };
    }
    return { error: "修改失败，请重试" };
  }
}
