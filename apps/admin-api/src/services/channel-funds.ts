import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { channelRecharges, channels, fundOperations } from '@ai-gateway/db/schema';
import { HttpError } from '@ai-gateway/http';
import { toDecimal } from '@ai-gateway/money';
import type { AdminServices } from './index.js';

/**
 * 渠道资金服务（入货 / 调账）。
 *
 * 入货 recharge：amount 恒正，可选支付订单号 + 凭证截图（base64 data URL → 存 storage）。
 * 调账 adjust：amount 可正可负（修正错误），不可把 upstream_budget 调成负。
 * 两者都在事务内：原子改 channels.upstream_budget + 写 channel_recharges（含 balance_after 快照）。
 *
 * P2-4：与用户侧资金操作同一套 fund_operations 幂等收据——同 operationId 重放
 * 返回首次结果（upstream_budget 只动一次）；同 key 不同请求 → 409。
 */

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

interface ChannelFundResult {
  rechargeId: number;
  balanceAfter: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * fund_operations 幂等收据（事务内首个语句）：
 *   - 插入成功 = 首次提交，继续执行资金变更；
 *   - 冲突 = 同 key 重放：kind + fingerprint 一致 → 返回首次结果（replayed），
 *     否则 409 IDEMPOTENCY_CONFLICT（网络重试携带不同 body 不得覆盖首次入账）。
 * 凭证截图内容不进 fingerprint（base64 最大 20MB）；以 hasVoucher 布尔参与指纹。
 */
async function claimFundOperation(
  tx: Parameters<Parameters<AdminServices['db']['transaction']>[0]>[0],
  input: { operationId: string; kind: 'channel.recharge' | 'channel.adjust'; fingerprint: string },
): Promise<ChannelFundResult | null> {
  const inserted = await tx
    .insert(fundOperations)
    .values({ operationId: input.operationId, kind: input.kind, fingerprint: input.fingerprint })
    .onConflictDoNothing({ target: fundOperations.operationId })
    .returning({ operationId: fundOperations.operationId });
  if (inserted.length > 0) return null;
  const existing = await tx.query.fundOperations.findFirst({
    where: eq(fundOperations.operationId, input.operationId),
  });
  if (!existing || existing.kind !== input.kind || existing.fingerprint !== input.fingerprint) {
    throw new HttpError('IDEMPOTENCY_CONFLICT', '幂等键已被不同请求使用');
  }
  if (!existing.result) throw new HttpError('IDEMPOTENCY_CONFLICT', '幂等操作尚未完成，请稍后重试');
  return existing.result as ChannelFundResult;
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
): Promise<ChannelFundResult & { replayed: boolean }> {
  const amountStr = String(input.amount);
  let voucherKey: string | null = null;
  if (input.voucherDataUrl) {
    const parsed = parseVoucherDataUrl(input.voucherDataUrl);
    if (!parsed) throw new HttpError('INVALID_VOUCHER', '凭证截图格式无效（仅支持 png/jpeg/webp/gif base64）');
    if (parsed.data.length > voucherMaxBytes) {
      throw new HttpError('VOUCHER_TOO_LARGE', `凭证截图超过 ${Math.floor(voucherMaxBytes / 1024 / 1024)}MB 上限`);
    }
    voucherKey = await s.voucherStorage.save(parsed.data, parsed.mimeType);
  }

  return s.db.transaction(async (tx) => {
    const fingerprint = sha256(
      JSON.stringify({
        kind: 'channel.recharge',
        channelId: input.channelId,
        amount: amountStr,
        orderNo: input.orderNo?.trim() || null,
        remark: input.remark?.trim() || null,
        adminId,
        hasVoucher: !!input.voucherDataUrl,
      }),
    );
    const replayed = await claimFundOperation(tx, { operationId, kind: 'channel.recharge', fingerprint });
    if (replayed) return { ...replayed, replayed: true };

    const [updated] = await tx
      .update(channels)
      .set({
        upstreamBudget: sql`${channels.upstreamBudget} + ${amountStr}::numeric`,
        // 入货后若渠道处于熔断(3)，自动复活为启用(0)
        status: sql`case when ${channels.status} = 3 then 0 else ${channels.status} end`,
        updatedAt: new Date(),
      })
      .where(eq(channels.id, input.channelId))
      .returning({ upstreamBudget: channels.upstreamBudget });
    if (!updated) throw new HttpError('CHANNEL_NOT_FOUND', '渠道不存在');
    const [recharge] = await tx
      .insert(channelRecharges)
      .values({
        channelId: input.channelId,
        type: 'recharge',
        amount: amountStr,
        balanceAfter: updated.upstreamBudget,
        orderNo: input.orderNo?.trim() || null,
        voucher: voucherKey,
        remark: input.remark?.trim() || null,
        adminId,
      })
      .returning({ id: channelRecharges.id });
    const stored: ChannelFundResult = {
      rechargeId: recharge!.id,
      balanceAfter: updated.upstreamBudget,
    };
    await tx
      .update(fundOperations)
      .set({ result: stored })
      .where(eq(fundOperations.operationId, operationId));
    return { ...stored, replayed: false };
  });
}

export async function adjustChannel(
  s: AdminServices,
  input: AdjustInput,
  adminId: number,
  operationId: string,
): Promise<ChannelFundResult & { replayed: boolean }> {
  const amountStr = String(input.amount);
  return s.db.transaction(async (tx) => {
    const fingerprint = sha256(
      JSON.stringify({
        kind: 'channel.adjust',
        channelId: input.channelId,
        amount: amountStr,
        remark: input.remark?.trim() || null,
        adminId,
      }),
    );
    const replayed = await claimFundOperation(tx, { operationId, kind: 'channel.adjust', fingerprint });
    if (replayed) return { ...replayed, replayed: true };

    const [updated] = await tx
      .update(channels)
      .set({
        upstreamBudget: sql`${channels.upstreamBudget} + ${amountStr}::numeric`,
        updatedAt: new Date(),
      })
      // 调账不能把进货额度调成负（余额不足于抵扣本次负调账）
      .where(
        sql`${channels.id} = ${input.channelId}
            and ${channels.upstreamBudget} + ${amountStr}::numeric >= 0`,
      )
      .returning({ upstreamBudget: channels.upstreamBudget });
    if (!updated) {
      const exists = await tx.query.channels.findFirst({
        where: eq(channels.id, input.channelId),
        columns: { id: true },
      });
      if (!exists) throw new HttpError('CHANNEL_NOT_FOUND', '渠道不存在');
      throw new HttpError('INSUFFICIENT_BUDGET', '调账金额超出当前进货额度，无法扣减');
    }
    const [recharge] = await tx
      .insert(channelRecharges)
      .values({
        channelId: input.channelId,
        type: 'adjust',
        amount: amountStr,
        balanceAfter: updated.upstreamBudget,
        remark: input.remark?.trim() || null,
        adminId,
      })
      .returning({ id: channelRecharges.id });
    const stored: ChannelFundResult = {
      rechargeId: recharge!.id,
      balanceAfter: updated.upstreamBudget,
    };
    await tx
      .update(fundOperations)
      .set({ result: stored })
      .where(eq(fundOperations.operationId, operationId));
    return { ...stored, replayed: false };
  });
}

/** 判断调账扣减是否会让预算为负（供路由预校验，事务内仍以 WHERE 兜底） */
export function adjustWouldBeNegative(currentBudget: string, amount: string): boolean {
  return toDecimal(currentBudget).plus(toDecimal(amount)).lt(0);
}
