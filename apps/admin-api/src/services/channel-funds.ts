/**
 * 渠道资金服务（S7 重写）：凭证校验/存储留在 app，资金动作直连 channel-budget 域。
 * 域内：recharge/adjust 幂等（ledger-core kinds 'channel.recharge'/'channel.adjust'）+
 * channels.upstream_budget 原子变更 + channel_recharges 流水。
 */
import { ChannelBudgetError } from '@ai-gateway/ledger/channel-budget';
import { LedgerError } from '@ai-gateway/ledger/platform';
import { HttpError } from '@ai-gateway/http';
import type { AdminServices } from './index.js';

/** 解析 base64 data URL → { data, mimeType }；非法返回 null */
export function parseVoucherDataUrl(dataUrl: string): { data: Buffer; mimeType: string } | null {
  const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) return null;
  try {
    return { data: Buffer.from(m[2]!, 'base64'), mimeType: m[1]! };
  } catch {
    return null;
  }
}

/** ChannelBudgetError / 幂等冲突 → HTTP（域码注册表单一真相） */
export function mapChannelBudgetError(error: unknown): HttpError {
  if (error instanceof ChannelBudgetError) {
    const table = {
      channel_not_found: { status: 404, code: 'CHANNEL_NOT_FOUND', message: '渠道不存在' },
      insufficient_budget: { status: 422, code: 'INSUFFICIENT_BUDGET', message: '调账金额超出当前进货额度，无法扣减' },
    } as const;
    const m = table[error.code];
    return new HttpError(m.code, error.message || m.message);
  }
  if (error instanceof LedgerError && error.code === 'idempotency_conflict') {
    throw new HttpError('IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
  }
  throw error;
}

export interface RechargeInput {
  channelId: number;
  /** 入货金额（元，>0） */
  amount: number;
  /** 支付订单号 */
  orderNo?: string;
  /** 支付凭证截图（base64 data URL） */
  voucherDataUrl?: string;
  remark?: string;
}

export interface AdjustInput {
  channelId: number;
  /** 调账金额（元，非 0，可正负） */
  amount: number;
  remark?: string;
}

export async function rechargeChannel(
  s: AdminServices,
  input: RechargeInput,
  adminId: number,
  voucherMaxBytes: number,
  operationId: string,
): Promise<{ rechargeId: number; balanceAfter: string; replayed: boolean }> {
  let voucherKey: string | null = null;
  if (input.voucherDataUrl) {
    const parsed = parseVoucherDataUrl(input.voucherDataUrl);
    if (!parsed) throw new HttpError('INVALID_VOUCHER', '凭证截图格式无效（仅支持 png/jpeg/webp/gif base64）');
    if (parsed.data.length > voucherMaxBytes) {
      throw new HttpError('VOUCHER_TOO_LARGE', `凭证截图超过 ${Math.floor(voucherMaxBytes / 1024 / 1024)}MB 上限`);
    }
    voucherKey = await s.voucherStorage.save(parsed.data, parsed.mimeType);
  }
  try {
    return await s.channelBudget.recharge({
      operationId,
      channelId: input.channelId,
      amount: String(input.amount),
      orderNo: input.orderNo?.trim() || null,
      voucherKey,
      remark: input.remark?.trim() || null,
      adminId,
    });
  } catch (error) {
    throw mapChannelBudgetError(error);
  }
}

export async function adjustChannel(
  s: AdminServices,
  input: AdjustInput,
  adminId: number,
  operationId: string,
): Promise<{ rechargeId: number; balanceAfter: string; replayed: boolean }> {
  try {
    return await s.channelBudget.adjust({
      operationId,
      channelId: input.channelId,
      amount: String(input.amount),
      remark: input.remark?.trim() || null,
      adminId,
    });
  } catch (error) {
    throw mapChannelBudgetError(error);
  }
}
