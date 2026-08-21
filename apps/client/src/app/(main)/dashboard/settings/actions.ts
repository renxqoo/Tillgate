"use server";

import { apiFetch, ApiError, setSessionToken } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

export async function changePasswordAction(input: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ error?: string; code?: string }> {
  const t = await getTranslations("settings");
  if (!input.oldPassword) return { error: t("oldPasswordRequired") };
  if (input.newPassword.length < 8) return { error: t("newPasswordMin") };
  if (input.newPassword.length > 128) return { error: t("newPasswordMax") };
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
    return { error: t("changeFailedRetry") };
  }
}

/** 修改显示名称（1-32 字符，服务端二次校验） */
export async function updateDisplayNameAction(input: {
  displayName: string;
}): Promise<{ error?: string; displayName?: string }> {
  const t = await getTranslations("settings");
  const name = input.displayName.trim();
  if (!name) return { error: t("nameRequired") };
  if (name.length > 32) return { error: t("nameTooLong") };
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
    return { error: t("changeFailedRetry") };
  }
}
