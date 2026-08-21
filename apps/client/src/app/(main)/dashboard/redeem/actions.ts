"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

export async function redeemAction(code: string): Promise<{ ok?: boolean; amount?: string; balanceAfter?: string; error?: string }> {
  const t = await getTranslations("redeem");
  const trimmed = code.trim();
  if (!trimmed) return { error: t("codeRequired") };
  try {
    const res = await apiFetch<{ ok: boolean; amount: string; balanceAfter: string }>("/v1/redeem", {
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
    return { error: t("redeemFailed") };
  }
}
