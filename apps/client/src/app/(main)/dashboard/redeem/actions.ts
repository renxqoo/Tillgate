"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

export async function redeemAction(code: string): Promise<{ ok?: boolean; amount?: string; balanceAfter?: string; error?: string }> {
  const trimmed = code.trim();
  if (!trimmed) return { error: "请输入充值码" };
  try {
    const res = await apiFetch<{ ok: boolean; amount: string; balanceAfter: string }>("/api/redeem", {
      method: "POST",
      body: { code: trimmed },
    });
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/redeem");
    return { ok: true, amount: res.amount, balanceAfter: res.balanceAfter };
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message };
    }
    return { error: "充值失败，请重试" };
  }
}
