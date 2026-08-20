"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 生成批次 ────────────────────────────────────────────────────────────────
export interface BatchGenerateInput {
  name: string;
  amount: string;
  count: number;
  remark?: string;
  expiresAt?: string;
}

export interface BatchGenerated {
  batch: { id: number; name: string; amount: string; total: number };
  codes: string[];
}

export async function generateBatchAction(
  input: BatchGenerateInput,
): Promise<{ error?: string; batch?: BatchGenerated }> {
  if (!/^\d{1,20}(?:\.\d{1,18})?$/.test(input.amount) || /^0+(?:\.0+)?$/.test(input.amount)) {
    return { error: "金额必须 > 0" };
  }
  if (input.count <= 0 || input.count > 1000) return { error: "数量必须在 1-1000" };
  if (!input.name?.trim()) return { error: "请输入批次名称" };
  try {
    const res = await adminFetch<BatchGenerated>("/v1/redeem-batches", {
      method: "POST",
      body: {
        name: input.name.trim(),
        remark: input.remark?.trim() || undefined,
        amount: input.amount,
        count: input.count,
        expiresAt: input.expiresAt || undefined,
      },
    });
    revalidatePath("/dashboard/redeem-batches");
    return { batch: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "生成失败" };
  }
}

// ── 撤销充值码 ──────────────────────────────────────────────────────────────
export async function revokeCodeAction(codeId: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/redeem-batches/codes/${codeId}/revoke`, { method: "POST" });
    revalidatePath("/dashboard/redeem-batches");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "撤销失败" };
  }
}
