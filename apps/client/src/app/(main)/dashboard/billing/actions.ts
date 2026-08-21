"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

export async function createPaymentAction(
  provider: "epay" | "stripe",
  amount: string,
): Promise<{ ok?: boolean; payUrl?: string; error?: string }> {
  try {
    const res = await apiFetch<{ orderId: string; payUrl: string }>("/v1/payments/orders", {
      method: "POST",
      body: { provider, amount },
    });
    revalidatePath("/dashboard/billing");
    return { ok: true, payUrl: res.payUrl };
  } catch (e) {
    if (e instanceof ApiError) {
      return { error: e.message };
    }
    const t = await getTranslations("billing");
    return { error: t("orderFailed") };
  }
}
