"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { adminFetch, ApiError } from "@ai-gateway/api-client";
import { SUPPORTED_PROTOCOLS } from "@ai-gateway/ai";

export interface ProviderInput {
  name: string;
  baseUrl: string;
  protocol?: string;
  /** 厂商档案（空串 = 不设置/清除——纯透传） */
  vendor?: string | null;
  status?: number;
}

export async function createProviderAction(input: ProviderInput): Promise<{ error?: string }> {
  const t = await getTranslations("providers");
  const tc = await getTranslations("common");
  if (!input.name?.trim()) return { error: t("nameRequired") };
  if (!input.baseUrl?.trim()) return { error: t("baseUrlRequired") };
  try {
    await adminFetch("/v1/providers", {
      method: "POST",
      body: {
        name: input.name.trim(),
        baseUrl: input.baseUrl.trim(),
        protocol: input.protocol?.trim() || SUPPORTED_PROTOCOLS[0]!,
        vendor: input.vendor?.trim() ? input.vendor.trim() : null,
        status: input.status ?? 0,
      },
    });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("createFailed") };
  }
}

export async function updateProviderAction(
  id: number,
  input: Partial<ProviderInput>,
): Promise<{ error?: string }> {
  const tc = await getTranslations("common");
  try {
    await adminFetch(`/v1/providers/${id}`, { method: "PATCH", body: input });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("saveFailed") };
  }
}

export async function deleteProviderAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations("common");
  try {
    await adminFetch(`/v1/providers/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/providers");
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("deleteFailed") };
  }
}
