'use server';

import { revalidatePath } from 'next/cache';

import { adminApi } from './admin-api';

/** 邀请关系封禁/恢复（封禁 = 停止该邀请人后续佣金；历史入账不动；审计落痕） */
export async function setRelationStatusAction(
  relationId: number,
  status: 0 | 1,
): Promise<{ ok: true }> {
  await adminApi().patch(`/v1/referrals/relations/${relationId}`, { status });
  revalidatePath('/dashboard/referrals');
  return { ok: true };
}
