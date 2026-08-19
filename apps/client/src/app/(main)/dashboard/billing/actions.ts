"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function createPaymentAction(
  provider: "epay" | "stripe",
  amount: string,
): Promise<{ ok?: boolean; payUrl?: string; error?: string }> {
  try {
    const res = await apiFetch<{ orderId: string; payUrl: string }>("/api/payments/orders", {
      method: "POST",
      body: { provider, amount },
    });
    revalidatePath("/dashboard/billing");
    return { ok: true, payUrl: res.payUrl };
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message };
    }
    return { error: "下单失败，请重试" };
  }
}
