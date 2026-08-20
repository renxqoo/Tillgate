"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

import type { AppCreated } from "@ai-gateway/api-client/types";

export async function createAppAction(input: {
  name: string;
  description?: string;
}): Promise<{ error?: string; app?: AppCreated }> {
  if (!input.name.trim()) return { error: "请输入名称" };
  try {
    const res = await apiFetch<AppCreated>("/v1/apps", {
      method: "POST",
      body: {
        name: input.name.trim(),
        description: input.description?.trim() || undefined,
      },
    });
    revalidatePath("/dashboard/apps");
    return { app: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

export async function rotateSecretAction(
  id: number,
): Promise<{ error?: string; clientSecret?: string }> {
  try {
    const res = await apiFetch<{ ok: boolean; clientSecret: string }>(
      `/v1/apps/${id}/rotate`,
      { method: "POST" },
    );
    revalidatePath("/dashboard/apps");
    return { clientSecret: res.clientSecret };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "轮换失败" };
  }
}

export async function deleteAppAction(id: number): Promise<{ error?: string }> {
  try {
    // v2 正位：删除 = 禁用（应用不物理删除——历史计费归属保留）
    await apiFetch(`/v1/apps/${id}/disable`, { method: "POST" });
    revalidatePath("/dashboard/apps");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
