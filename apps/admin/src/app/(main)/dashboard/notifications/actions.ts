'use server';

import { revalidatePath } from 'next/cache';
import { ApiError, adminFetch } from '@ai-gateway/api-client';

export interface NotificationChannelInput {
  name: string;
  type: 'webhook' | 'email';
  config: { url?: string; secret?: string; recipients?: string[] };
  events: string[];
  status?: number;
}

export async function createChannelAction(input: NotificationChannelInput): Promise<{ error?: string }> {
  try {
    await adminFetch('/api/admin/notifications', { method: 'POST', body: input });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '创建失败' };
  }
}

export async function toggleChannelAction(id: number, status: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/notifications/${id}`, { method: 'PATCH', body: { status } });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '更新失败' };
  }
}

export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/notifications/${id}`, { method: 'DELETE' });
    revalidatePath('/dashboard/notifications');
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '删除失败' };
  }
}

export async function testChannelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/notifications/${id}/test`, { method: 'POST' });
    return {};
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : '测试事件发送失败' };
  }
}
