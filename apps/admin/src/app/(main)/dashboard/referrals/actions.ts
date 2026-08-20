'use server';

import { revalidatePath } from 'next/cache';

import { adminFetch } from '@ai-gateway/api-client';

/** 邀请关系封禁/恢复（封禁 = 停止该邀请人后续佣金；历史入账不动；审计落痕） */
export async function setRelationStatusAction(relationId: number, status: 0 | 1): Promise<{ ok: true }> {
  await adminFetch(`/v1/referrals/relations/${relationId}`, { method: 'PATCH', body: { status } });
  revalidatePath('/dashboard/referrals');
  return { ok: true };
}
