"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 入货 ─────────────────────────────────────────────────────────────────────
export interface RechargeInput {
  channelId: number;
  amount: string;
  orderNo?: string;
  /** 凭证截图 base64 data URL */
  voucherDataUrl?: string;
  remark?: string;
}

export async function rechargeChannelAction(
  input: RechargeInput,
): Promise<{ error?: string }> {
  const t = await getTranslations("channelFunds");
  if (!input.channelId) return { error: t("channelRequired") };
  if (!/^\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) <= 0) return { error: t("amountPositive") };
  try {
    await adminFetch("/v1/channel-funds/recharge", {
      method: "POST",
      body: {
        channelId: input.channelId,
        amount: input.amount,
        orderNo: input.orderNo?.trim() || undefined,
        voucherDataUrl: input.voucherDataUrl || undefined,
        remark: input.remark?.trim() || undefined,
      },
    });
    revalidatePath("/dashboard/channel-funds");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("rechargeFailed") };
  }
}

// ── 调账 ─────────────────────────────────────────────────────────────────────
export interface AdjustInput {
  channelId: number;
  amount: string;
  remark?: string;
}

export async function adjustChannelAction(
  input: AdjustInput,
): Promise<{ error?: string }> {
  const t = await getTranslations("channelFunds");
  if (!input.channelId) return { error: t("channelRequired") };
  if (!/^-?\d+(?:\.\d+)?$/.test(input.amount) || Number(input.amount) === 0) return { error: t("amountNonZero") };
  try {
    await adminFetch("/v1/channel-funds/adjust", {
      method: "POST",
      body: {
        channelId: input.channelId,
        amount: input.amount,
        remark: input.remark?.trim() || undefined,
      },
    });
    revalidatePath("/dashboard/channel-funds");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("adjustFailed") };
  }
}
