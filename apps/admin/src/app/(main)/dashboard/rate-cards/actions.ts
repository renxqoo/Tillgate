"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 创建费率卡 ──────────────────────────────────────────────────────────────
export interface RateCardCreateInput {
  name: string;
  coefficient: number;
  description?: string;
}

export async function createRateCardAction(
  input: RateCardCreateInput,
): Promise<{ error?: string }> {
  if (!input.name.trim()) return { error: "请输入名称" };
  try {
    await adminFetch("/api/admin/rate-cards", {
      method: "POST",
      body: {
        name: input.name.trim(),
        coefficient: input.coefficient,
        description: input.description?.trim() || undefined,
      },
    });
    revalidatePath("/dashboard/rate-cards");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

// ── 编辑费率卡 ──────────────────────────────────────────────────────────────
export interface RateCardUpdateInput {
  name?: string;
  description?: string;
  status?: number;
  coefficient?: number;
}

export async function updateRateCardAction(
  id: number,
  input: RateCardUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/rate-cards/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/rate-cards");
    revalidatePath(`/dashboard/rate-cards/${id}`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

// ── 删除费率卡 ──────────────────────────────────────────────────────────────
export async function deleteRateCardAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/rate-cards/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/rate-cards");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
