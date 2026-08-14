"use server";

import { revalidatePath } from "next/cache";

import { apiFetch, ApiError } from "@ai-gateway/api-client";

import type { KeyCreated, KeyRow } from "./types";

export async function createKeyAction(input: {
  name: string;
  remark?: string;
}): Promise<{ error?: string; key?: KeyCreated }> {
  if (!input.name.trim()) return { error: "请输入名称" };
  try {
    const res = await apiFetch<KeyCreated>("/api/keys", {
      method: "POST",
      body: { name: input.name.trim(), remark: input.remark?.trim() || undefined },
    });
    revalidatePath("/dashboard/keys");
    return { key: res };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

export async function updateKeyAction(
  id: number,
  input: {
    name?: string;
    remark?: string;
    rpmLimit?: number | null;
    tpmLimit?: number | null;
    dailySpendLimit?: number | null;
  },
): Promise<{ error?: string }> {
  try {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = input.name.trim();
    if (input.remark !== undefined) body.remark = input.remark.trim() || null;
    if (input.rpmLimit !== undefined) body.rpmLimit = input.rpmLimit;
    if (input.tpmLimit !== undefined) body.tpmLimit = input.tpmLimit;
    if (input.dailySpendLimit !== undefined) body.dailySpendLimit = input.dailySpendLimit;
    await apiFetch<KeyRow>(`/api/keys/${id}`, { method: "PATCH", body });
    revalidatePath("/dashboard/keys");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "更新失败" };
  }
}

export async function revokeKeyAction(id: number): Promise<{ error?: string }> {
  try {
    await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/keys");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "吊销失败" };
  }
}
