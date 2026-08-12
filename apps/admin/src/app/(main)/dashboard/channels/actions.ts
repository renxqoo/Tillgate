"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";

// ── 创建渠道 ────────────────────────────────────────────────────────────────
export interface ChannelCreateInput {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string;
  models?: string;
  weight?: number;
  priority?: number;
}

export async function createChannelAction(
  input: ChannelCreateInput,
): Promise<{ error?: string }> {
  if (!input.name?.trim()) return { error: "请输入渠道名称" };
  if (!input.apiKey?.trim()) return { error: "请输入 API Key" };
  try {
    await adminFetch("/api/admin/channels", {
      method: "POST",
      body: {
        providerId: input.providerId,
        name: input.name.trim(),
        apiKey: input.apiKey,
        baseUrlOverride: input.baseUrlOverride?.trim() || undefined,
        models: input.models?.trim() || undefined,
        weight: input.weight ?? 100,
        priority: input.priority ?? 0,
      },
    });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "创建失败" };
  }
}

// ── 编辑渠道 ────────────────────────────────────────────────────────────────
export interface ChannelUpdateInput {
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string;
  models?: string;
  weight?: number;
  priority?: number;
  status?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
}

export async function updateChannelAction(
  id: number,
  input: ChannelUpdateInput,
): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/channels/${id}`, {
      method: "PATCH",
      body: input,
    });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}

// ── 删除渠道 ────────────────────────────────────────────────────────────────
export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/channels/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "删除失败" };
  }
}

// ── 测试渠道连通性 ──────────────────────────────────────────────────────────
export interface ChannelTestResult {
  ok?: boolean;
  durationMs?: number;
  error?: string;
  keyPreview?: string;
}

export async function testChannelAction(id: number): Promise<ChannelTestResult> {
  try {
    const res = await adminFetch<{
      ok: boolean;
      durationMs: number;
      error?: string | { code?: string; message?: string };
      keyPreview?: string;
    }>(`/api/admin/channels/${id}/test`, { method: "POST" });

    if (!res.ok) {
      // error 可能是 string 或 { code, message }
      let errMsg: string;
      if (typeof res.error === "string") {
        errMsg = res.error;
      } else if (res.error && typeof res.error === "object") {
        errMsg = res.error.message ?? res.error.code ?? "测试失败";
      } else {
        errMsg = "测试失败";
      }
      return { ok: false, durationMs: res.durationMs, error: errMsg };
    }
    return { ok: true, durationMs: res.durationMs, keyPreview: res.keyPreview };
  } catch (e) {
    const msg = e instanceof ApiError
      ? (typeof e.message === "string" ? e.message : JSON.stringify(e.message))
      : "测试失败";
    return { error: msg };
  }
}

// ── 批量导入渠道 ────────────────────────────────────────────────────────────
export interface ChannelImportItem {
  provider: string;
  name: string;
  apiKey: string;
  models?: string;
  weight?: number;
  priority?: number;
}

export async function importChannelsAction(
  channels: ChannelImportItem[],
): Promise<{ error?: string; created?: number }> {
  if (!channels.length) return { error: "请输入至少一条渠道" };
  try {
    const res = await adminFetch<{ created: number } | { list?: unknown[] } | unknown>(
      "/api/admin/channels/import",
      { method: "POST", body: { channels } },
    );
    revalidatePath("/dashboard/channels");
    const created =
      (res as { created?: number })?.created ??
      (res as { list?: unknown[] })?.list?.length ??
      channels.length;
    return { created };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "导入失败" };
  }
}
