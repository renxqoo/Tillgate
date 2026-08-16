"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";
import { SUPPORTED_PROTOCOLS } from "@ai-gateway/ai";

export interface ProviderInput {
  name: string;
  baseUrl: string;
  protocol?: string;
  status?: number;
}

export async function createProviderAction(input: ProviderInput): Promise<{ error?: string }> {
  if (!input.name?.trim()) return { error: "请输入名称" };
  if (!input.baseUrl?.trim()) return { error: "请输入 Base URL" };
  try {
    await adminFetch("/api/admin/providers", {
      method: "POST",
      body: {
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim(),
        protocol: input.protocol?.trim() || SUPPORTED_PROTOCOLS[0]!,
        status: input.status ?? 0,
      },
    });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

export async function updateProviderAction(
  id: number,
  input: Partial<ProviderInput>,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/providers/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

export async function deleteProviderAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/providers/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}
