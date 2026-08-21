"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";
import { getTranslations } from "next-intl/server";

export async function purchaseSubscriptionAction(
  planId: number,
  quantity = 1,
): Promise<{ error?: string }> {
  const t = await getTranslations("subscription");
  if (!planId) return { error: t("planRequired") };
  if (!Number.isInteger(quantity) || quantity < 1) return { error: t("seatsAtLeast1") };
  try {
    await apiFetch("/v1/subscriptions", {
      method: "POST",
      body: { planId, quantity },
    });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("purchaseFailed") };
  }
}

// ── 变更（升级 / 扩容补差价）────────────────────────────────────────────────
export async function changeSubscriptionAction(
  id: number,
  input: { targetPlanId: number; quantity: number },
): Promise<{ error?: string }> {
  const t = await getTranslations("subscription");
  try {
    await apiFetch(`/v1/subscriptions/${id}/change`, { method: "POST", body: input });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("changeFailed") };
  }
}

// ── 续费（按原席位扣余额、顺延订阅期）──────────────────────────────────────
export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations("subscription");
  try {
    await apiFetch(`/v1/subscriptions/${id}/renew`, { method: "POST" });
    revalidatePath("/dashboard/subscription");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("renewFailed") };
  }
}

