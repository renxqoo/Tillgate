/**
 * 渠道进货（幂等）：budget += amount（正数）；熔断(3)自动复活为启用(0)。
 * 凭证字节先行落存储（事务外——字节不进指纹，重放不重传）；操作行+余额+流水同事务。
 */
import type { Db } from '@tokenlens/db';
import type { AuditSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import type { OperationsStore } from '../../ports/operations-store';
import type { VoucherStorage } from '../../ports/voucher-storage';
import { parseNonNegativeAmount } from '../../domain/money';
import { parseVoucherDataUrl } from '../../domain/channel/voucher';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAudit } from '../audit';
import { runOperation, type RunOperationDeps } from './run-operation';

export interface RechargeChannelDeps extends RunOperationDeps {
  readonly db: Db;
  readonly stores: {
    readonly channel: ChannelStore;
    readonly operations: OperationsStore;
  };
  readonly voucherStorage: VoucherStorage;
  /** 凭证大小上限（字节；装配注入） */
  readonly voucherMaxBytes: number;
  readonly audit: AuditSink;
}

export interface RechargeChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
  readonly amount: string;
  readonly orderNo?: string | null;
  readonly voucherDataUrl?: string | null;
  readonly remark?: string | null;
  readonly operationId: string;
}

export interface RechargeChannelResult {
  readonly ok: true;
  readonly rechargeId: number;
  readonly balanceAfter: string;
  readonly replayed: boolean;
}

export async function rechargeChannel(
  deps: RechargeChannelDeps,
  input: RechargeChannelInput,
): Promise<RechargeChannelResult> {
  if (parseNonNegativeAmount(input.amount) == null) {
    throw controlPlaneErrors.business('invalid_channel_input', { amount: input.amount });
  }
  // 凭证先行落存储（事务外——字节不进指纹，重放不重传）
  let voucherKey: string | null = null;
  if (input.voucherDataUrl) {
    const parsed = parseVoucherDataUrl(input.voucherDataUrl, deps.voucherMaxBytes);
    voucherKey = await deps.voucherStorage.save(parsed.data, parsed.mimeType);
  }
  const orderNo = input.orderNo?.trim() || null;
  const remark = input.remark?.trim() || null;
  const adminId = adminIdOf(input.ctx);
  if (adminId == null) {
    // 进货是管理员操作——actor 语义由装配保证，违约在此显式失败
    throw controlPlaneErrors.business('invalid_channel_input', { actor: 'not_admin' });
  }

  const { receipt, replayed } = await runOperation(deps, {
    ctx: input.ctx,
    operationId: input.operationId,
    kind: 'channel.recharge',
    payload: {
      kind: 'channel.recharge',
      channelId: input.channelId,
      amount: input.amount,
      orderNo,
      remark,
      adminId,
      hasVoucher: voucherKey != null,
    },
    execute: async (tx) => {
      const channel = await deps.stores.channel.findChannelFunds(tx, input.channelId);
      if (!channel)
        throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
      // 进货：budget += amount；熔断(3)自动复活为启用(0)；返回新余额快照
      const balanceAfter = await deps.stores.channel.rechargeBudget(tx, {
        channelId: input.channelId,
        amount: input.amount,
        now: new Date(),
      });
      const rechargeId = await deps.stores.channel.insertRecharge(tx, {
        channelId: input.channelId,
        type: 'recharge',
        amount: input.amount,
        balanceAfter,
        orderNo,
        voucher: voucherKey,
        remark,
        adminId,
      });
      return { rechargeId, balanceAfter };
    },
  });
  await emitAudit(deps.audit, {
    actor: 'admin',
    adminId,
    action: 'channel.recharge',
    targetType: 'channel',
    targetId: input.channelId,
    detail: { amount: input.amount, orderNo, hasVoucher: voucherKey != null, remark },
  });
  return { ok: true as const, ...receipt, replayed };
}
