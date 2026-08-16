"use server";

import { revalidatePath } from "next/cache";

import { adminFetch, ApiError } from "@ai-gateway/api-client";
import type { ChannelCreateBody, ChannelTestResult, ChannelUpdateBody } from "@ai-gateway/api-client/types";

// ── 创建渠道 ────────────────────────────────────────────────────────────────
export async function createChannelAction(
  input: ChannelCreateBody,
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
export async function updateChannelAction(
  id: number,
  input: ChannelUpdateBody,
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
/** 归一化后的连通性测试结果（error 恒为 string，供 client toast 直接展示）。 */
export interface ChannelTestOutcome {
  ok?: boolean;
  durationMs?: number;
  error?: string;
  keyPreview?: string;
}

export async function testChannelAction(id: number): Promise<ChannelTestOutcome> {
  try {
    const res = await adminFetch<ChannelTestResult>(`/api/admin/channels/${id}/test`, {
      method: "POST",
    });

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
