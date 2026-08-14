"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 续费 ─────────────────────────────────────────────────────────────────────
export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/subscriptions/${id}/renew`, { method: "POST" });
    revalidatePath("/dashboard/subscriptions");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "续费失败" };
  }
}

// ── 取消 ─────────────────────────────────────────────────────────────────────
export async function cancelSubscriptionAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/subscriptions/${id}/cancel`, { method: "POST" });
    revalidatePath("/dashboard/subscriptions");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "取消失败" };
  }
}
