"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { adminFetch, ApiError } from "@ai-gateway/api-client";
import type { ChannelTestResult } from "@ai-gateway/api-client/types";

// ─────────────────────────────────────────────────────────────────────────────
// 表单侧输入类型：models 是逗号分隔文本（管理端表单 UX 形态）。
// 线上契约（channels 路由 zod / DB jsonb / GET 响应 / import）是 string[]。
// 字符串 → 数组的转换只在本边界发生一次——修复缺陷：表单把字符串直传
// z.array 校验的接口，填了模型白名单的创建/编辑/导入必然 4xx。
// ─────────────────────────────────────────────────────────────────────────────

interface ChannelFormCreateInput {
  providerId: number;
  name: string;
  apiKey: string;
  baseUrlOverride?: string;
  models?: string;
  weight?: number;
  priority?: number;
}

interface ChannelFormUpdateInput {
  name?: string;
  apiKey?: string;
  baseUrlOverride?: string;
  models?: string;
  weight?: number;
  priority?: number;
  status?: number;
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  upstreamThreshold?: string | null;
}

/** 逗号/空白/中文逗号分隔的白名单文本 → 数组；空文本 → undefined（创建=不限，编辑=不变） */
function splitModels(value?: string): string[] | undefined {
  if (!value?.trim()) return undefined;
  const list = value
    .split(/[\s,，]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

// ── 创建渠道 ────────────────────────────────────────────────────────────────
export async function createChannelAction(
  input: ChannelFormCreateInput,
): Promise<{ error?: string }> {
  const t = await getTranslations("channels");
  const tc = await getTranslations("common");
  if (!input.name?.trim()) return { error: t("channelNameRequired") };
  if (!input.apiKey?.trim()) return { error: t("apiKeyRequired") };
  try {
    await adminFetch("/v1/channels", {
      method: "POST",
      body: {
        providerId: input.providerId,
        name: input.name.trim(),
        apiKey: input.apiKey,
        baseUrlOverride: input.baseUrlOverride?.trim() || undefined,
        models: splitModels(input.models),
        weight: input.weight ?? 100,
        priority: input.priority ?? 0,
      },
    });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("createFailed") };
  }
}

// ── 编辑渠道 ────────────────────────────────────────────────────────────────
export async function updateChannelAction(
  id: number,
  input: ChannelFormUpdateInput,
): Promise<{ error?: string }> {
  const tc = await getTranslations("common");
  try {
    await adminFetch(`/v1/channels/${id}`, {
      method: "PATCH",
      body: {
        name: input.name,
        apiKey: input.apiKey,
        baseUrlOverride: input.baseUrlOverride,
        models: splitModels(input.models),
        weight: input.weight,
        priority: input.priority,
        status: input.status,
        rpmLimit: input.rpmLimit,
        tpmLimit: input.tpmLimit,
        upstreamThreshold: input.upstreamThreshold,
      },
    });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("saveFailed") };
  }
}

// ── 删除渠道 ────────────────────────────────────────────────────────────────
export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations("common");
  try {
    await adminFetch(`/v1/channels/${id}`, { method: "DELETE" });
    revalidatePath("/dashboard/channels");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc("deleteFailed") };
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
  const t = await getTranslations("channels");
  try {
    const res = await adminFetch<ChannelTestResult>(`/v1/channels/${id}/test`, {
      method: "POST",
    });

    if (!res.ok) {
      // error 可能是 string 或 { code, message }
      let errMsg: string;
      if (typeof res.error === "string") {
        errMsg = res.error;
      } else if (res.error && typeof res.error === "object") {
        errMsg = res.error.message ?? res.error.code ?? t("testFailed");
      } else {
        errMsg = t("testFailed");
      }
      return { ok: false, durationMs: res.durationMs, error: errMsg };
    }
    return { ok: true, durationMs: res.durationMs, keyPreview: res.keyPreview };
  } catch (e) {
    const msg = e instanceof ApiError
      ? (typeof e.message === "string" ? e.message : JSON.stringify(e.message))
      : t("testFailed");
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
  const t = await getTranslations("channels");
  if (!channels.length) return { error: t("importEmpty") };
  try {
    const res = await adminFetch<{ created: number } | { list?: unknown[] } | unknown>(
      "/v1/channels/import",
      {
        method: "POST",
        body: {
          channels: channels.map((item) => ({ ...item, models: splitModels(item.models) })),
        },
      },
    );
    revalidatePath("/dashboard/channels");
    const created =
      (res as { created?: number })?.created ??
      (res as { list?: unknown[] })?.list?.length ??
      channels.length;
    return { created };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t("importFailed") };
  }
}
