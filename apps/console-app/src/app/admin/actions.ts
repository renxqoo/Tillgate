'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { apiFetch } from '@/lib/api-client';

/** 取当前会话 Cookie 字符串（透传给 admin-api） */
export async function cookieStr(): Promise<string> {
  const jar = await cookies();
  const token = jar.get('ag_session')?.value;
  return token ? `ag_session=${token}` : '';
}

/** 通用 admin-api 调用（带 Cookie + revalidate 失败捕获） */
export async function adminFetch<T>(
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; revalidate?: number } = {},
): Promise<T> {
  return apiFetch<T>(path, { ...opts, cookieHeader: await cookieStr() });
}

/** 刷新指定路径的缓存（CRUD 后调用，让列表页重新渲染） */
export async function refresh(path: string): Promise<void> {
  revalidatePath(path);
}

/** 充值码批次生成 */
export async function createRedeemBatchAction(formData: FormData): Promise<{ error?: string; codes?: string[] }> {
  const name = String(formData.get('name') ?? '');
  const amount = Number(formData.get('amount') ?? 0);
  const count = Number(formData.get('count') ?? 0);
  const remark = formData.get('remark') ? String(formData.get('remark')) : undefined;
  if (!name || amount <= 0 || count <= 0) return { error: '请填写名称、面额（厘）和数量' };
  try {
    const res = await adminFetch<{ codes: string[] }>('/api/admin/redeem-batches', {
      method: 'POST',
      body: { name, amount, count, remark },
    });
    await refresh('/admin/redeem-batches');
    return { codes: res.codes };
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '生成失败' };
  }
}

/** 作废充值码 */
export async function revokeRedeemCodeAction(codeId: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/redeem-batches/codes/${codeId}/revoke`, { method: 'POST' });
    await refresh('/admin/redeem-batches');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '作废失败' };
  }
}

// ============ 费率卡 ============

export async function createRateCardAction(formData: FormData): Promise<{ error?: string }> {
  const name = String(formData.get('name') ?? '');
  const coefficient = Number(formData.get('coefficient') ?? 0);
  const description = formData.get('description') ? String(formData.get('description')) : undefined;
  if (!name || coefficient <= 0) return { error: '请填写名称和系数' };
  try {
    await adminFetch('/api/admin/rate-cards', { method: 'POST', body: { name, coefficient, description } });
    await refresh('/admin/rate-cards');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '创建失败' };
  }
}

export async function updateRateCardAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const body: Record<string, unknown> = {};
  const name = formData.get('name');
  const coefficient = formData.get('coefficient');
  const description = formData.get('description');
  const status = formData.get('status');
  if (name) body.name = String(name);
  if (coefficient) body.coefficient = Number(coefficient);
  if (description !== null) body.description = description ? String(description) : null;
  if (status !== null) body.status = Number(status);
  try {
    await adminFetch(`/api/admin/rate-cards/${id}`, { method: 'PATCH', body });
    await refresh('/admin/rate-cards');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '更新失败' };
  }
}

export async function deleteRateCardAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/rate-cards/${id}`, { method: 'DELETE' });
    await refresh('/admin/rate-cards');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '删除失败' };
  }
}

// ============ 用户管理 ============

export async function updateUserStatusAction(id: number, status: number, freezeReason?: string): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: { status, freezeReason: status === 1 ? (freezeReason ?? '管理员封禁') : undefined } });
    await refresh('/admin/users');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '操作失败' };
  }
}

export async function adjustUserBalanceAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const amount = Number(formData.get('amount') ?? 0);
  const remark = formData.get('remark') ? String(formData.get('remark')) : undefined;
  if (!amount) return { error: '调账金额不能为 0' };
  try {
    await adminFetch(`/api/admin/users/${id}/adjust`, { method: 'POST', body: { amount, remark } });
    await refresh('/admin/users');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '调账失败' };
  }
}

export async function setUserPasswordAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const password = String(formData.get('password') ?? '');
  if (password.length < 8) return { error: '密码至少 8 位' };
  try {
    await adminFetch(`/api/admin/users/${id}/set-password`, { method: 'POST', body: { password } });
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '设置失败' };
  }
}

export async function bindRateCardAction(id: number, rateCardId: number | null): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/users/${id}`, { method: 'PATCH', body: { rateCardId } });
    await refresh('/admin/users');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '绑定失败' };
  }
}

// ============ 渠道 ============

export async function createChannelAction(formData: FormData): Promise<{ error?: string }> {
  const providerId = Number(formData.get('providerId') ?? 0);
  const name = String(formData.get('name') ?? '');
  const apiKey = String(formData.get('apiKey') ?? '');
  const baseUrlOverride = formData.get('baseUrlOverride') ? String(formData.get('baseUrlOverride')) : null;
  const weight = Number(formData.get('weight') ?? 1);
  const priority = Number(formData.get('priority') ?? 0);
  if (!providerId || !name || !apiKey) return { error: '请填写供应商、名称和 API Key' };
  try {
    await adminFetch('/api/admin/channels', { method: 'POST', body: { providerId, name, apiKey, baseUrlOverride, weight, priority } });
    await refresh('/admin/channels');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '创建失败' };
  }
}

export async function updateChannelAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const body: Record<string, unknown> = {};
  for (const k of ['name', 'baseUrlOverride', 'weight', 'priority', 'status', 'rpmLimit', 'tpmLimit']) {
    const v = formData.get(k);
    if (v !== null) {
      if (k === 'weight' || k === 'priority' || k === 'status' || k === 'rpmLimit' || k === 'tpmLimit') {
        body[k] = Number(v);
      } else {
        body[k] = k === 'baseUrlOverride' && v === '' ? null : String(v);
      }
    }
  }
  const apiKey = formData.get('apiKey');
  if (apiKey) body.apiKey = String(apiKey);
  try {
    await adminFetch(`/api/admin/channels/${id}`, { method: 'PATCH', body });
    await refresh('/admin/channels');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '更新失败' };
  }
}

export async function deleteChannelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/channels/${id}`, { method: 'DELETE' });
    await refresh('/admin/channels');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '删除失败' };
  }
}

export async function testChannelAction(id: number): Promise<{ ok?: boolean; error?: string; result?: { ok: boolean; durationMs?: number; error?: { code?: string; message?: string } } }> {
  try {
    const res = await adminFetch<{ ok: boolean; durationMs?: number; error?: { code?: string; message?: string } }>(`/api/admin/channels/${id}/test`, { method: 'POST' });
    return { result: res };
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '测试失败' };
  }
}

export async function importChannelsAction(formData: FormData): Promise<{ error?: string; result?: { total: number; success: number; failed: number } }> {
  const raw = String(formData.get('json') ?? '');
  if (!raw.trim()) return { error: '请粘贴 JSON 数组' };
  let channels: unknown;
  try {
    channels = JSON.parse(raw);
  } catch {
    return { error: 'JSON 格式错误' };
  }
  try {
    const res = await adminFetch<{ total: number; success: number; failed: number }>('/api/admin/channels/import', { method: 'POST', body: { channels } });
    await refresh('/admin/channels');
    return { result: res };
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '导入失败' };
  }
}

// ============ 模型映射 ============

export async function createModelAction(formData: FormData): Promise<{ error?: string }> {
  const externalName = String(formData.get('externalName') ?? '');
  const realModel = String(formData.get('realModel') ?? '');
  const inputPrice = Number(formData.get('inputPrice') ?? 0);
  const outputPrice = Number(formData.get('outputPrice') ?? 0);
  const cacheInputPrice = Number(formData.get('cacheInputPrice') ?? 0);
  if (!externalName || !realModel) return { error: '请填写对外模型名和真实模型名' };
  try {
    await adminFetch('/api/admin/models', { method: 'POST', body: { externalName, realModel, inputPrice, outputPrice, cacheInputPrice } });
    await refresh('/admin/models');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '创建失败' };
  }
}

export async function updateModelAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const body: Record<string, unknown> = {};
  for (const k of ['externalName', 'realModel', 'inputPrice', 'outputPrice', 'cacheInputPrice', 'status']) {
    const v = formData.get(k);
    if (v !== null) {
      if (['inputPrice', 'outputPrice', 'cacheInputPrice', 'status'].includes(k)) {
        body[k] = Number(v);
      } else {
        body[{
          externalName: 'externalName',
          realModel: 'realModel',
        }[k] ?? k] = String(v);
      }
    }
  }
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: 'PATCH', body });
    await refresh('/admin/models');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '更新失败' };
  }
}

export async function deleteModelAction(id: number): Promise<{ error?: string }> {
  try {
    await adminFetch(`/api/admin/models/${id}`, { method: 'DELETE' });
    await refresh('/admin/models');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '删除失败' };
  }
}

export async function bindModelChannelsAction(id: number, formData: FormData): Promise<{ error?: string }> {
  const raw = String(formData.get('channels') ?? '[]');
  let channels: Array<{ channelId: number; weight?: number; priority?: number }>;
  try {
    channels = JSON.parse(raw);
  } catch {
    return { error: 'channels JSON 格式错误' };
  }
  try {
    await adminFetch(`/api/admin/models/${id}/channels`, { method: 'POST', body: { channels } });
    await refresh('/admin/models');
    return {};
  } catch (e) {
    return { error: (e as { message?: string })?.message ?? '绑定失败' };
  }
}
