"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 续费 ─────────────────────────────────────────────────────────────────────
export async function renewSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations("subscriptions");
  try {
    await adminFetch(`/v1/subscriptions/${id}/renew`, { method: "POST" });
    revalidatePath("/dashboard/subscriptions");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("renewFailed") };
  }
}

// ── 取消 ─────────────────────────────────────────────────────────────────────
export async function cancelSubscriptionAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations("subscriptions");
  try {
    await adminFetch(`/v1/subscriptions/${id}/cancel`, { method: "POST" });
    revalidatePath("/dashboard/subscriptions");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("cancelFailed") };
  }
}

// ── 变更（升级 / 扩容补差价）────────────────────────────────────────────────
export interface SubscriptionChangeInput {
  targetPlanId: number;
  quantity: number;
}

export async function changeSubscriptionAction(
  id: number,
  input: SubscriptionChangeInput,
): Promise<{ error?: string }> {
  const t = await getTranslations("subscriptions");
  try {
    await adminFetch(`/v1/subscriptions/${id}/change`, { method: "POST", body: input });
    revalidatePath("/dashboard/subscriptions");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("changeFailed") };
  }
}
