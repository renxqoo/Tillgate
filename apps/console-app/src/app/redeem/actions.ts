'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

async function cookieStr(): Promise<string> {
  const jar = await cookies();
  const token = jar.get('ag_session')?.value;
  return token ? `ag_session=${token}` : '';
}

export async function redeemAction(formData: FormData): Promise<{ error?: string; ok?: boolean; balanceAfter?: string }> {
  const code = String(formData.get('code') ?? '');
  if (!code) return { error: '请输入充值码' };
  try {
    const res = await apiFetch<{ ok: boolean; amount: string; balanceAfter: string }>('/api/redeem', {
      method: 'POST',
      body: { code },
      cookieHeader: await cookieStr(),
    });
    revalidatePath('/redeem');
    revalidatePath('/dashboard');
    return { ok: true, balanceAfter: res.balanceAfter };
  } catch (e) {
    const err = e as { message?: string; code?: string };
    const msgMap: Record<string, string> = {
      invalid_code: '充值码无效',
      code_already_used: '充值码已被使用',
      code_revoked: '充值码已作废',
      code_expired: '充值码已过期',
    };
    return { error: (err.code && msgMap[err.code]) ?? err.message ?? '兑换失败' };
  }
}
