"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 创建模型映射 ────────────────────────────────────────────────────────────
export interface ModelCreateInput {
  externalName: string;
  realModel: string;
  inputPrice: number;
  outputPrice: number;
  cacheInputPrice?: number;
}

export async function createModelAction(input: ModelCreateInput): Promise<{ error?: string }> {
  if (!input.externalName.trim() || !input.realModel.trim()) {
    return { error: "名称不能为空" };
  }
  try {
    await adminFetch("/api/admin/models", {
      method: "POST",
      body: {
        externalName: input.externalName.trim(),
        realModel: input.realModel.trim(),
        inputPrice: input.inputPrice,
        outputPrice: input.outputPrice,
        cacheInputPrice: input.cacheInputPrice ?? 0,
      },
    });
    revalidatePath("/dashboard/models");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

// ── 编辑模型映射 ────────────────────────────────────────────────────────────
export interface ModelUpdateInput {
  externalName?: string;
  realModel?: string;
  inputPrice?: number;
  outputPrice?: number;
  cacheInputPrice?: number;
  fallbackModels?: string;
  paramRules?: string;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  status?: number;
}

export async function updateModelAction(
  id: number,
  input: ModelUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/models");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

// ── 删除模型映射 ────────────────────────────────────────────────────────────
export async function deleteModelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/models");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}

// ── 绑定渠道 ────────────────────────────────────────────────────────────────
export async function bindChannelsAction(
  id: number,
  channelIds: number[],
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}/channels`, {
      method: "POST",
      body: { channelIds },
    });
    revalidatePath("/dashboard/models");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "绑定失败" };
  }
}
