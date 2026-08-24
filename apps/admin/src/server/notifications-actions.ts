'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError } from '@tillgate/api-client';
import { adminApi } from './admin-api';

export interface NotificationChannelInput {
  name: string;
  type: 'webhook' | 'email';
  config: { url?: string; secret?: string; recipients?: string[] };
  events: string[];
  status?: number;
}

export async function createChannelAction(
  input: NotificationChannelInput,
): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().post('/v1/notifications', input);
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('createFailed') };
  }
}

export async function toggleChannelAction(id: number, status: number): Promise<{ error?: string }> {
  const t = await getTranslations('notifications');
  try {
    await adminApi().patch(`/v1/notifications/${id}`, { status });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('updateFailed') };
  }
}

export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminApi().delete(`/v1/notifications/${id}`);
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('deleteFailed') };
  }
}

export async function testChannelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('notifications');
  try {
    await adminApi().post(`/v1/notifications/${id}/test`);
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('testFailed') };
  }
}
