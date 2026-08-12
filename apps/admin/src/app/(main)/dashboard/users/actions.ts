"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 用户调账 ────────────────────────────────────────────────────────────────
export async function adjustBalanceAction(
  id: number,
  input: { amount: number; remark: string },
): Promise<{ error?: string }> {
  if (!Number.isFinite(input.amount) || input.amount === 0) {
    return { error: "调账金额必须为非零数字" };
  }
  try {
    await adminFetch(`/api/admin/users/${id}/adjust`, {
      method: "POST",
      body: { amount: input.amount, remark: input.remark?.trim() || undefined },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "调账失败" };
  }
}

// ── 重置密码 ────────────────────────────────────────────────────────────────
export async function setPasswordAction(
  id: number,
  input: { password: string },
): Promise<{ error?: string }> {
  if (!input.password || input.password.length < 6) {
    return { error: "密码至少 6 位" };
  }
  try {
    await adminFetch(`/api/admin/users/${id}/set-password`, {
      method: "POST",
      body: { password: input.password },
    });
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "设置密码失败" };
  }
}

// ── 赠送余额 ────────────────────────────────────────────────────────────────
export async function giftUserAction(
  id: number,
  input: { amount: number; remark: string },
): Promise<{ error?: string }> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { error: "赠送金额必须 > 0" };
  }
  try {
    await adminFetch(`/api/admin/users/${id}/gift`, {
      method: "POST",
      body: { amount: input.amount, remark: input.remark?.trim() || undefined },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "赠送失败" };
  }
}

// ── 封禁 / 解封 + 冻结原因 ─────────────────────────────────────────────────
export async function setUserStatusAction(
  id: number,
  input: { status: number; freezeReason?: string },
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/users/${id}`, {
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
    return { error: e instanceof ApiError ? e.message : "操作失败" };
  }
}

// ── 绑定费率卡 ──────────────────────────────────────────────────────────────
export async function bindRateCardAction(
  id: number,
  rateCardId: number | null,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: rateCardId === null ? { rateCardId: null } : { rateCardId },
    });
    revalidatePath("/dashboard/users");
    revalidatePath(`/dashboard/users/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "绑定费率卡失败" };
  }
}
