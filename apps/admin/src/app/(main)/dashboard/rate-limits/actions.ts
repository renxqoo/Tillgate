"use server";

import { revalidatePath } from "next/cache";

import { ApiError, adminFetch } from "@ai-gateway/api-client";

import type { RateLimitKind } from "./types";

const PATH_BY_KIND: Record<RateLimitKind, (id: number) => string> = {
  user: (id) => `/api/admin/users/${id}`,
  model: (id) => `/api/admin/models/${id}`,
  channel: (id) => `/api/admin/channels/${id}`,
  key: (id) => `/api/admin/keys/${id}`,
};

/**
 * 统一更新限流（null=不限流，继承上层）。
 * 改后 admin-api 端清缓存：user/key 清 auth:key:{hash}，model/channel 走 invalidateRouteCache，立即生效。
 */
export async function updateRateLimitAction(
  kind: RateLimitKind,
  id: number,
  rpmLimit: number | null,
  tpmLimit: number | null,
): Promise<{ error?: string }> {
  try {
    await adminFetch(PATH_BY_KIND[kind](id), {
      method: "PATCH",
      body: { rpmLimit, tpmLimit },
    });
    revalidatePath("/dashboard/rate-limits");
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : "保存失败" };
  }
}
