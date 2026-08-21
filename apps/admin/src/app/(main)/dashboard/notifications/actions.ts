'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from 'next-intl/server';
import { ApiError, adminFetch } from '@ai-gateway/api-client';

export interface NotificationChannelInput {
  name: string;
  type: 'webhook' | 'email';
  config: { url?: string; secret?: string; recipients?: string[] };
  events: string[];
  status?: number;
}

export async function createChannelAction(input: NotificationChannelInput): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminFetch('/v1/notifications', { method: 'POST', body: input });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('createFailed') };
  }
}

export async function toggleChannelAction(id: number, status: number): Promise<{ error?: string }> {
  const t = await getTranslations('notifications');
  try {
    await adminFetch(`/v1/notifications/${id}`, { method: 'PATCH', body: { status } });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('updateFailed') };
  }
}

export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  const tc = await getTranslations('common');
  try {
    await adminFetch(`/v1/notifications/${id}`, { method: 'DELETE' });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : tc('deleteFailed') };
  }
}

export async function testChannelAction(id: number): Promise<{ error?: string }> {
  const t = await getTranslations('notifications');
  try {
    await adminFetch(`/v1/notifications/${id}/test`, { method: 'POST' });
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : t('testFailed') };
  }
}
