"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 创建套餐 ─────────────────────────────────────────────────────────────────
export interface PlanCreateInput {
  name: string;
  price: number;
  periodDays: number;
  quotaAmount: number;
  fallbackToBalance?: boolean;
}

export async function createPlanAction(input: PlanCreateInput): Promise<{ error?: string }> {
  if (!input.name.trim()) return { error: "请输入套餐名称" };
  try {
    await adminFetch("/api/admin/plans", {
      method: "POST",
      body: {
        name: input.name.trim(),
        price: input.price,
        periodDays: input.periodDays,
        quotaAmount: input.quotaAmount,
        fallbackToBalance: input.fallbackToBalance ?? false,
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
  price?: number;
  periodDays?: number;
  quotaAmount?: number;
  fallbackToBalance?: boolean;
  status?: number;
}

export async function updatePlanAction(
  id: number,
  input: PlanUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/plans/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

// ── 删除套餐 ─────────────────────────────────────────────────────────────────
export async function deletePlanAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/plans/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/plans");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
