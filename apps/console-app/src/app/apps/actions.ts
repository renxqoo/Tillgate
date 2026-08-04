'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

async function cookieStr(): Promise<string> {
  const jar = await cookies();
  const token = jar.get('ag_session')?.value;
  return token ? `ag_session=${token}` : '';
}

export async function createAppAction(formData: FormData): Promise<{ error?: string; clientSecret?: string }> {
  const name = String(formData.get('name') ?? '');
  const description = formData.get('description') ? String(formData.get('description')) : undefined;
  if (!name) return { error: '请输入应用名称' };
  try {
    const res = await apiFetch<{ id: number; clientSecret: string }>('/api/apps', {
      method: 'POST',
      body: { name, description },
      cookieHeader: await cookieStr(),
    });
    revalidatePath('/apps');
    return { clientSecret: res.clientSecret };
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '创建失败' };
  }
}
