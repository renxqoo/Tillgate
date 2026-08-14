"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 入货 ─────────────────────────────────────────────────────────────────────
export interface RechargeInput {
  channelId: number;
  amount: number;
  orderNo?: string;
  /** 凭证截图 base64 data URL */
  voucherDataUrl?: string;
  remark?: string;
}

export async function rechargeChannelAction(
  input: RechargeInput,
): Promise<{ error?: string }> {
  if (!input.channelId) return { error: "请选择渠道" };
  if (!input.amount || input.amount <= 0) return { error: "入货金额须 > 0" };
  try {
    await adminFetch("/api/admin/channel-funds/recharge", {
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
    return { error: e instanceof ApiError ? e.message : "入货失败" };
  }
}

// ── 调账 ─────────────────────────────────────────────────────────────────────
export interface AdjustInput {
  channelId: number;
  amount: number;
  remark?: string;
}

export async function adjustChannelAction(
  input: AdjustInput,
): Promise<{ error?: string }> {
  if (!input.channelId) return { error: "请选择渠道" };
  if (!input.amount || input.amount === 0) return { error: "调账金额不能为 0" };
  try {
    await adminFetch("/api/admin/channel-funds/adjust", {
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
    return { error: e instanceof ApiError ? e.message : "调账失败" };
  }
}
