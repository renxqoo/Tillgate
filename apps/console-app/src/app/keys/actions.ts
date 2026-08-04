'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

const ADMIN_API_BASE = process.env.ADMIN_API_BASE ?? 'http://localhost:8790';

async function cookieStr(): Promise<string> {
  const jar = await cookies();
  const token = jar.get('ag_session')?.value;
  return token ? `ag_session=${token}` : '';
}

/** 创建 Key（明文仅此一次回显） */
export async function createKeyAction(formData: FormData): Promise<{ error?: string; key?: string }> {
  const name = String(formData.get('name') ?? '');
  const remark = formData.get('remark') ? String(formData.get('remark')) : undefined;
  if (!name) return { error: '请输入名称' };
  try {
    const res = await apiFetch<{ id: number; name: string; key: string }>('/api/keys', {
      method: 'POST',
      body: { name, remark },
      cookieHeader: await cookieStr(),
    });
    revalidatePath('/keys');
    return { key: res.key };
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '创建失败' };
  }
}

/** 吊销 Key */
export async function revokeKeyAction(id: number): Promise<void> {
  await fetch(`${ADMIN_API_BASE}/api/keys/${id}`, {
    method: 'DELETE',
    headers: { cookie: await cookieStr() },
    cache: 'no-store',
  });
  revalidatePath('/keys');
}
