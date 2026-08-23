'use server';

/** 组织成员管理 action：邀请（一次性 token 链接）/接受/限额修补/撤销邀请/移除成员。 */
import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';

import { ApiError } from '@tokenlens/api-client';

import { createClientApi } from '../api';

export async function inviteMemberAction(
  orgId: number,
  email: string,
): Promise<{ error?: string; link?: string }> {
  const t = await getTranslations('orgs');
  if (!email.trim()) return { error: t('emailRequired') };
  try {
    const res = await createClientApi().post<{ invitationId: number; token: string }>(
      `/v1/orgs/${orgId}/invitations`,
      { email: email.trim() },
    );
    revalidatePath('/dashboard/orgs');
    // token 仅邀请创建时下发一次（服务端不回显）——站内接受链接即时生成
    return { link: `/dashboard/orgs/accept?token=${res.token}` };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('inviteFailed') };
  }
}

export async function acceptInviteAction(token: string): Promise<{ error?: string }> {
  const t = await getTranslations('orgs');
  try {
    await createClientApi().post('/v1/orgs/invitations/accept', { token });
    revalidatePath('/dashboard/orgs');
    revalidatePath('/dashboard/keys');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('acceptFailed') };
  }
}

export async function setMemberQuotaAction(
  orgId: number,
  userId: number,
  input: { dailySpendLimit?: string | null; monthlyQuota?: string | null },
): Promise<{ error?: string }> {
  const t = await getTranslations('common');
  try {
    await createClientApi().patch(`/v1/orgs/${orgId}/members/${userId}`, input);
    revalidatePath('/dashboard/orgs');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('saveFailed') };
  }
}

export async function revokeInvitationAction(
  orgId: number,
  invitationId: number,
): Promise<{ error?: string }> {
  const t = await getTranslations('orgs');
  try {
    await createClientApi().post(`/v1/orgs/${orgId}/invitations/${invitationId}/revoke`);
    revalidatePath('/dashboard/orgs');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('revokeFailed') };
  }
}

export async function removeMemberAction(
  orgId: number,
  userId: number,
): Promise<{ error?: string }> {
  const t = await getTranslations('orgs');
  try {
    await createClientApi().delete(`/v1/orgs/${orgId}/members/${userId}`);
    revalidatePath('/dashboard/orgs');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('removeFailed') };
  }
}
