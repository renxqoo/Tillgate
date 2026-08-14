"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function purchaseSubscriptionAction(
  planId: number,
  quantity = 1,
): Promise<{ error?: string }> {
  if (!planId) return { error: "请选择套餐" };
  if (!Number.isInteger(quantity) || quantity < 1) return { error: "席位至少为 1" };
  try {
    await apiFetch("/api/subscriptions", {
      method: "POST",
      body: { planId, quantity },
    });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "购买失败" };
  }
}

// ── 变更（升级 / 扩容补差价）────────────────────────────────────────────────
export async function changeSubscriptionAction(
  id: number,
  input: { targetPlanId: number; quantity: number },
): Promise<{ error?: string }> {
  try {
    await apiFetch(`/api/subscriptions/${id}/change`, { method: "POST", body: input });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "变更失败" };
  }
}

// ── 续费（按原席位扣余额、顺延订阅期）──────────────────────────────────────
export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/api/subscriptions/${id}/renew`, { method: "POST" });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "续费失败" };
  }
}

