'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

/** 管理员管理动作（admins 域——super_admin;403/409 等由后端域守卫与编排权威判定） */

/** 创建响应的投递结果面（完整资料行由列表刷新呈现） */
interface AdminCreatedResult {
  inviteSent?: boolean;
}

export async function createAdminAction(input: {
  email: string;
  displayName?: string;
  roleId: number;
}): Promise<{ error?: string; inviteSent: boolean }> {
  const t = await getTranslations('admins');
  try {
    const created = await adminApi().post<AdminCreatedResult>('/v1/admins', input);
    revalidatePath('/dashboard/admins');
    return { inviteSent: created.inviteSent === true };
  } catch (error) {
    if (error instanceof ApiError && error.code === 'control_plane.admin_email_taken') {
      return { error: t('emailTaken'), inviteSent: false };
    }
    return {
      error: error instanceof ApiError ? error.message : t('createFailed'),
      inviteSent: false,
    };
  }
}

/** 重发邀请邮件（仅待激活管理员;60s 冷却与 SMTP 前置由后端权威判定） */
export async function resendAdminInviteAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('admins');
  try {
    await adminApi().post(`/v1/admins/${id}/resend-invite`);
    revalidatePath('/dashboard/admins');
    return {};
  } catch (error) {
    if (error instanceof ApiError) {
      const mapped: Record<string, string> = {
        'admin.admin_invite_rate_limited': t('resendCooldown'),
        'admin.admin_invite_not_needed': t('alreadyActivated'),
        'admin.admin_invite_link_unavailable': t('inviteUnavailable'),
        'admin.admin_not_found': t('adminNotFound'),
      };
      return { error: (error.code != null && mapped[error.code]) || error.message };
    }
    return { error: t('resendFailed') };
  }
}

export async function updateAdminRoleAction(
  id: number,
  roleId: number,
): Promise<{ error?: string }> {
  const t = await getTranslations('admins');
  try {
    await adminApi().patch(`/v1/admins/${id}`, { roleId });
    revalidatePath('/dashboard/admins');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('updateFailed') };
  }
}

export async function toggleAdminStatusAction(
  id: number,
  status: 0 | 1,
): Promise<{ error?: string }> {
  const t = await getTranslations('admins');
  try {
    await adminApi().patch(`/v1/admins/${id}`, { status });
    revalidatePath('/dashboard/admins');
    return {};
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : t('updateFailed') };
  }
}
