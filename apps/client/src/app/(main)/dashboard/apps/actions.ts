"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

import type { AppCreated, AppRow } from "./types";

export async function createAppAction(input: {
  name: string;
  description?: string;
}): Promise<{ error?: string; app?: AppCreated }> {
  if (!input.name.trim()) return { error: "请输入名称" };
  try {
    const res = await apiFetch<AppCreated>("/api/apps", {
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
      `/api/apps/${id}/rotate-secret`,
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
    await apiFetch<AppRow>(`/api/apps/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/apps");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
