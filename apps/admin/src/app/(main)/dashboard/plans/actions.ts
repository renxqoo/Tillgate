"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 创建套餐 ─────────────────────────────────────────────────────────────────
export interface PlanCreateInput {
  name: string;
  kind?: "subscription" | "pack";
  sortOrder?: number | null;
  price: string;
  /** 包月 1~3650；加油包 0 */
  periodDays: number;
  quotaAmount: string;
  allowSeats?: boolean;
}

export async function createPlanAction(input: PlanCreateInput): Promise<{ error?: string }> {
  if (!input.name.trim()) return { error: "请输入套餐名称" };
  try {
    await adminFetch("/v1/plans", {
      method: "POST",
      body: {
        name: input.name.trim(),
        kind: input.kind ?? "subscription",
        sortOrder: input.sortOrder ?? null,
        price: input.price,
        periodDays: input.periodDays,
        quotaAmount: input.quotaAmount,
        allowSeats: input.allowSeats ?? false,
      },
    });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

// ── 编辑套餐 ─────────────────────────────────────────────────────────────────
export interface PlanUpdateInput {
  name?: string;
  sortOrder?: number | null;
  price?: string;
  periodDays?: number;
  quotaAmount?: string;
  allowSeats?: boolean;
  status?: number;
}

export async function updatePlanAction(
  id: number,
  input: PlanUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/plans/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

// ── 删除套餐 ─────────────────────────────────────────────────────────────────
export async function deletePlanAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/v1/plans/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}

// ── 发放加油包（仅 kind=pack 的套餐）────────────────────────────────────────
export async function grantPackAction(
  planId: number,
  userId: number,
): Promise<{ error?: string }> {
  if (!Number.isInteger(userId) || userId <= 0) return { error: "请输入有效用户 ID" };
  try {
    await adminFetch(`/v1/subscriptions/${planId}/grant`, { method: "POST", body: { userId } });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "发放失败" };
  }
}
