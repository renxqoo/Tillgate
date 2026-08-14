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

// ── Key（订阅页席位视角：建 / 轮换 / 吊销）──────────────────────────────────
export async function createSubscriptionKeyAction(input: {
  name: string;
  dailySpendLimit?: number;
}): Promise<{ error?: string; key?: { id: number; name: string; key: string } }> {
  if (!input.name.trim()) return { error: "请输入名称" };
  try {
    const res = await apiFetch<{ id: number; name: string; key: string }>("/api/keys", {
      method: "POST",
      body: {
        name: input.name.trim(),
        ...(input.dailySpendLimit != null ? { dailySpendLimit: input.dailySpendLimit } : {}),
      },
    });
    revalidatePath("/dashboard/subscription");
    return { key: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

export async function rotateSubscriptionKeyAction(
  id: number,
): Promise<{ error?: string; key?: { id: number; name: string; key: string } }> {
  try {
    const res = await apiFetch<{ id: number; name: string; key: string }>(
      `/api/keys/${id}/rotate`,
      { method: "POST" },
    );
    revalidatePath("/dashboard/subscription");
    return { key: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "刷新失败" };
  }
}

export async function revokeSubscriptionKeyAction(id: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
