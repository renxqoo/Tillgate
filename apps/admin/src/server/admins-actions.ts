'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

/** 管理员管理动作（admins 域——super_admin;403/409 等由后端域守卫与编排权威判定） */

export async function createAdminAction(input: {
  email: string;
  displayName?: string;
  password: string;
  roleId: number;
}): Promise<{ error?: string }> {
  const t = await getTranslations('admins');
  try {
    await adminApi().post('/v1/admins', input);
    revalidatePath('/dashboard/admins');
    return {};
  } catch (error) {
    if (error instanceof ApiError && error.code === 'control_plane.admin_email_taken') {
      return { error: t('emailTaken') };
    }
    return { error: error instanceof ApiError ? error.message : t('createFailed') };
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
