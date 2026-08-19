/**
 * channel-budget/recharge：管理端进货/调账（S4，自 admin-api channel-funds 上移）。
 *
 * 运营资金域，自治（plan §7/§11 Q3）：channels.upstream_budget 是公司采购预算，
 * 与用户资金永不混账；未来进总账用 platform_revenue → channel_cost 的
 * wallet.transfer 结转（预留，不在本期）。
 * 凭证截图（base64 校验 + storage）是 app 表现层职责，域收已落储的 voucherKey。
 * 幂等：ledger-core kinds 'channel.recharge' / 'channel.adjust'；指纹不含截图内容。
 */
import { eq, sql } from 'drizzle-orm';
import { channelRecharges, channels } from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { ChannelBudgetError } from '../platform/errors.js';
import type { ChannelBudgetContext } from './types.js';

export interface RechargeInput {
  operationId: string;
  channelId: number;
  /** 入货金额（元，>0） */
  amount: string;
  /** 支付订单号 */
  orderNo?: string | null;
  /** 凭证截图（调用方已落储的 storage key；不进指纹） */
  voucherKey?: string | null;
  remark?: string | null;
  adminId: number;
}

export interface AdjustInput {
  operationId: string;
  channelId: number;
  /** 调账金额（元，非 0，可正负——修正错误） */
  amount: string;
  remark?: string | null;
  adminId: number;
}

export interface ChannelFundResult {
  rechargeId: number;
  balanceAfter: string;
  replayed: boolean;
}

export async function rechargeChannel(
  ctx: ChannelBudgetContext,
  input: RechargeInput,
): Promise<ChannelFundResult> {
  if (!toDecimal(input.amount).gt(0)) {
    throw new ChannelBudgetError('insufficient_budget', 'recharge amount must be positive');
  }
  const { receipt, replayed } = await ctx.operations.run({
    operationId: input.operationId,
    kind: 'channel.recharge',
    fingerprint: {
      kind: 'channel.recharge',
      channelId: input.channelId,
      amount: input.amount,
      orderNo: input.orderNo ?? null,
      remark: input.remark ?? null,
      adminId: input.adminId,
      hasVoucher: input.voucherKey != null,
    },
    execute: async (tx) => {
      const [updated] = await tx
        .update(channels)
        .set({
          upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`,
          // 入货后若渠道处于熔断(3)，自动复活为启用(0)
          status: sql`case when ${channels.status} = 3 then 0 else ${channels.status} end`,
          updatedAt: ctx.clock(),
        })
        .where(eq(channels.id, input.channelId))
        .returning({ upstreamBudget: channels.upstreamBudget });
      if (!updated) throw new ChannelBudgetError('channel_not_found');
      const [recharge] = await tx
        .insert(channelRecharges)
        .values({
          channelId: input.channelId,
          type: 'recharge',
          amount: input.amount,
          balanceAfter: updated.upstreamBudget,
          orderNo: input.orderNo ?? null,
          voucher: input.voucherKey ?? null,
          remark: input.remark ?? null,
          adminId: input.adminId,
        })
        .returning({ id: channelRecharges.id });
      return {
        rechargeId: recharge!.id,
        balanceAfter: updated.upstreamBudget,
      };
    },
  });
  return { ...receipt, replayed };
}

export async function adjustChannel(
  ctx: ChannelBudgetContext,
  input: AdjustInput,
): Promise<ChannelFundResult> {
  if (toDecimal(input.amount).isZero()) {
    throw new ChannelBudgetError('insufficient_budget', 'adjust amount must be non-zero');
  }
  const { receipt, replayed } = await ctx.operations.run({
    operationId: input.operationId,
    kind: 'channel.adjust',
    fingerprint: {
      kind: 'channel.adjust',
      channelId: input.channelId,
      amount: input.amount,
      remark: input.remark ?? null,
      adminId: input.adminId,
    },
    execute: async (tx) => {
      const [updated] = await tx
        .update(channels)
        .set({
          upstreamBudget: sql`${channels.upstreamBudget} + ${input.amount}::numeric`,
          updatedAt: ctx.clock(),
        })
        // 调账不能把进货额度调成负（余额不足于抵扣本次负调账）
        .where(
          sql`${channels.id} = ${input.channelId}
              and ${channels.upstreamBudget} + ${input.amount}::numeric >= 0`,
        )
        .returning({ upstreamBudget: channels.upstreamBudget });
      if (!updated) {
        const exists = await tx.query.channels.findFirst({
          where: eq(channels.id, input.channelId),
          columns: { id: true },
        });
        if (!exists) throw new ChannelBudgetError('channel_not_found');
        throw new ChannelBudgetError('insufficient_budget');
      }
      const [recharge] = await tx
        .insert(channelRecharges)
        .values({
          channelId: input.channelId,
          type: 'adjust',
          amount: input.amount,
          balanceAfter: updated.upstreamBudget,
          remark: input.remark ?? null,
          adminId: input.adminId,
        })
        .returning({ id: channelRecharges.id });
      return {
        rechargeId: recharge!.id,
        balanceAfter: updated.upstreamBudget,
      };
    },
  });
  return { ...receipt, replayed };
}

/** 判断调账扣减是否会让预算为负（供路由预校验，事务内仍以 WHERE 兜底） */
export function adjustWouldBeNegative(currentBudget: string, amount: string): boolean {
  return toDecimal(currentBudget).plus(toDecimal(amount)).lt(0);
}
