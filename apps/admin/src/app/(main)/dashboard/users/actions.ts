"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 用户调账 ────────────────────────────────────────────────────────────────
export async function adjustBalanceAction(
  id: number,
  input: { amount: string; remark: string },
): Promise<{ error?: string }> {
  const t = await getTranslations("users");
  if (!/^-?\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) === 0) {
    return { error: t("adjustNonZero") };
  }
  try {
    await adminFetch(`/v1/users/${id}/adjust`, {
      method: "POST",
      body: { amount: input.amount, remark: input.remark?.trim() || undefined },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("adjustFailed") };
  }
}

// ── 重置密码 ────────────────────────────────────────────────────────────────
export async function setPasswordAction(
  id: number,
  input: { password: string },
): Promise<{ error?: string }> {
  const t = await getTranslations("users");
  if (!input.password || input.password.length < 6) {
    return { error: t("passwordMin6") };
  }
  try {
    await adminFetch(`/v1/users/${id}/set-password`, {
      method: "POST",
      body: { password: input.password },
    });
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("setPasswordFailed") };
  }
}

// ── 赠送余额 ────────────────────────────────────────────────────────────────
export async function giftUserAction(
  id: number,
  input: { amount: string; remark: string },
): Promise<{ error?: string }> {
  const t = await getTranslations("users");
  if (!/^\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) {
    return { error: t("giftPositive") };
  }
  try {
    await adminFetch(`/v1/users/${id}/gift`, {
      method: "POST",
      body: { amount: input.amount, remark: input.remark?.trim() || undefined },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("giftFailed") };
  }
}

// ── 封禁 / 解封 + 冻结原因 ─────────────────────────────────────────────────
export async function setUserStatusAction(
  id: number,
  input: { status: number; freezeReason?: string },
): Promise<{ error?: string }> {
  const t = await getTranslations("common");
  try {
    await adminFetch(`/v1/users/${id}`, {
      method: "PATCH",
      body: {
        status: input.status,
        ...(input.freezeReason !== undefined ? { freezeReason: input.freezeReason } : {}),
      },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("actionFailed") };
  }
}

// ── 设为 / 取消 企业用户 ────────────────────────────────────────────────────
export async function setUserEnterpriseAction(
  id: number,
  isEnterprise: boolean,
): Promise<{ error?: string }> {
  const t = await getTranslations("common");
  try {
    await adminFetch(`/v1/users/${id}`, {
      method: "PATCH",
      body: { isEnterprise },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("actionFailed") };
  }
}

// ── 绑定费率卡 ──────────────────────────────────────────────────────────────
export async function bindRateCardAction(
  id: number,
  rateCardId: number | null,
): Promise<{ error?: string }> {
  const t = await getTranslations("users");
  try {
    await adminFetch(`/v1/users/${id}`, {
      method: "PATCH",
      body: rateCardId === null ? { rateCardId: null } : { rateCardId },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("bindFailed") };
  }
}
