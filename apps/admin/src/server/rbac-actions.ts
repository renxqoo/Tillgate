'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tokenlens/api-client';
import { adminApi } from './admin-api';

/** RBAC v2 管理动作（roles/permissions;守卫与审计全在后端——此处只透传错误码语义） */

export async function createRoleAction(input: {
  code: string;
  name: string;
  description?: string | null;
  permissions: string[];
}): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('roles');
  try {
    await adminApi().createRole(input);
    revalidatePath('/dashboard/roles');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), [
      'role_exists',
      'invalid_role_input',
      'invalid_permission_code',
    ]);
  }
}

export async function updateRoleAction(
  id: number,
  input: { name?: string; description?: string | null; status?: number; permissions?: string[] },
): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('roles');
  try {
    await adminApi().updateRole(id, input);
    revalidatePath('/dashboard/roles');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), [
      'role_immutable',
      'role_not_found',
      'invalid_permission_code',
    ]);
  }
}

export async function deleteRoleAction(id: number): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('roles');
  try {
    await adminApi().deleteRole(id);
    revalidatePath('/dashboard/roles');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), ['role_immutable', 'role_in_use', 'role_not_found']);
  }
}

export async function createPermissionAction(input: {
  parentId: number | null;
  type: 'group' | 'page' | 'button';
  code: string | null;
  name: string;
  path?: string | null;
  icon?: string | null;
  sortOrder: number;
}): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('permissions');
  try {
    await adminApi().createPermission(input);
    revalidatePath('/dashboard/permissions');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), [
      'permission_code_taken',
      'invalid_permission_input',
      'permission_not_found',
    ]);
  }
}

export async function updatePermissionAction(
  id: number,
  input: {
    name?: string;
    icon?: string | null;
    sortOrder?: number;
    status?: number;
    i18nKey?: string | null;
  },
): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('permissions');
  try {
    await adminApi().updatePermission(id, input);
    revalidatePath('/dashboard/permissions');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), ['permission_immutable', 'permission_not_found']);
  }
}

export async function deletePermissionAction(
  id: number,
): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('permissions');
  try {
    await adminApi().deletePermission(id);
    revalidatePath('/dashboard/permissions');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), [
      'permission_immutable',
      'permission_has_children',
      'permission_in_use',
    ]);
  }
}

/** control_plane.* 错误码 → errorKey（调用方按 roles.errors.<key> / permissions.errors.<key> 渲染） */
function errorOf(
  e: unknown,
  fallback: (key: string) => string,
  keys: readonly string[],
): { error?: string; errorKey?: string } {
  if (e instanceof ApiError && e.code) {
    const short = e.code.replace('control_plane.', '');
    if (keys.includes(short)) return { errorKey: short };
    return { error: e.message };
  }
  return { error: fallback('actionFailed') };
}
