"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function purchaseSubscriptionAction(planId: number): Promise<{ error?: string }> {
  if (!planId) return { error: "请选择套餐" };
  try {
    await apiFetch("/api/subscriptions", {
      method: "POST",
      body: { planId },
    });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "购买失败" };
  }
}
