'use server';

import { revalidatePath } from 'next/cache';
import { ApiError } from '@tokenlens/api-client';
import { adminApi } from './admin-api';
import { getTranslations } from 'next-intl/server';

/** 接口绑定管理动作（ADR-0009;守卫与审计全在后端） */

export async function createBindingAction(input: {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  permissionId: number;
}): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('endpoints');
  try {
    await adminApi().createEndpointBinding(input);
    revalidatePath('/dashboard/endpoints');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), [
      'endpoint_bound',
      'invalid_endpoint_input',
      'permission_not_found',
    ]);
  }
}

export async function rebindAction(
  id: number,
  permissionId: number,
): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('endpoints');
  try {
    await adminApi().rebindEndpoint(id, permissionId);
    revalidatePath('/dashboard/endpoints');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), ['endpoint_not_found', 'permission_not_found']);
  }
}

export async function deleteBindingAction(
  id: number,
): Promise<{ error?: string; errorKey?: string }> {
  const t = await getTranslations('endpoints');
  try {
    await adminApi().deleteEndpointBinding(id);
    revalidatePath('/dashboard/endpoints');
    return {};
  } catch (e) {
    return errorOf(e, (key) => t(key), ['endpoint_not_found']);
  }
}

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
