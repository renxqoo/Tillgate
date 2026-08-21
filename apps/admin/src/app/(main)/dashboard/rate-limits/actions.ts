"use server";

import { revalidatePath } from "next/cache";

import { ApiError, adminFetch } from "@ai-gateway/api-client";

import type { RateLimitKind } from "./types";

const PATH_BY_KIND: Record<RateLimitKind, (id: number) => string> = {
  user: (id) => `/v1/users/${id}`,
  model: (id) => `/v1/models/${id}`,
  channel: (id) => `/v1/channels/${id}`,
  key: (id) => `/v1/admin-keys/${id}`,
};

export interface RateLimitPatch {
  rpmLimit: number | null;
  tpmLimit: number | null;
  /** 仅 user：透支上限（元，>=0）。必填数值，不可为 null（DB notNull default 0）。 */
  creditLimit?: string;
  /** user/key：每日花费上限（元，NULL=不限）。 */
  dailySpendLimit?: string | null;
}

/**
 * 统一更新限流（null=不限流，继承上层）。
 * 改后 admin-api 端清缓存：user/key 清 auth:key:{hash}，model/channel 走 invalidateRouteCache，立即生效。
 */
export async function updateRateLimitAction(
  kind: RateLimitKind,
  id: number,
  patch: RateLimitPatch,
): Promise<{ error?: string }> {
  try {
    const body: Record<string, number | string | null> = {
      rpmLimit: patch.rpmLimit,
      tpmLimit: patch.tpmLimit,
    };
    // 信用模型字段仅 user/key 实体支持（模型/渠道无 creditLimit / dailySpendLimit）
    if (kind === "user") {
      if (patch.creditLimit !== undefined) body.creditLimit = patch.creditLimit;
      if (patch.dailySpendLimit !== undefined) body.dailySpendLimit = patch.dailySpendLimit;
    } else if (kind === "key") {
      if (patch.dailySpendLimit !== undefined) body.dailySpendLimit = patch.dailySpendLimit;
    }
    await adminFetch(PATH_BY_KIND[kind](id), {
      method: "PATCH",
      body,
    });
    revalidatePath("/dashboard/rate-limits");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}
