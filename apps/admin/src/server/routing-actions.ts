'use server';

/**
 * 智能路由管理动作：策略保存（PUT /v1/routing-policy——admin-api 侧
 * routingPolicySchema 校验 + version 自增 + 审计；网关 TTL 拾取后 ≤15s 生效）。
 */
import { revalidatePath } from 'next/cache';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

export interface RoutingPolicyDraft {
  /** routingPolicySchema 形状的完整策略体（表单聚合成 JSON——服务端再校验） */
  policy: unknown;
  note?: string;
}

export async function saveRoutingPolicyAction(
  input: RoutingPolicyDraft,
): Promise<{ ok: true; version?: string } | { ok: false; error: string }> {
  try {
    const res = await adminApi().put<{ ok: boolean; version?: string }>('/v1/routing-policy', {
      policy: input.policy,
      ...(input.note != null ? { note: input.note } : {}),
    });
    revalidatePath('/dashboard/routing');
    return { ok: true, version: res.version };
  } catch (error) {
    return { ok: false, error: error instanceof ApiError ? error.message : String(error) };
  }
}
