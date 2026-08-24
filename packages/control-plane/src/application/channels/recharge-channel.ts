/**
 * 渠道进货（幂等）：budget += amount（正数）；熔断(3)自动复活为启用(0)。
 * 凭证字节先行落存储（事务外——字节不进指纹，重放不重传）；操作行+余额+流水+审计同事务
 * （§5.4/G3：资金审计与业务同事务——审计写失败随事务回滚）。
 */
import type { Db } from '@tillgate/db';
import type { AuditTxSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import type { OperationsStore } from '../../ports/operations-store';
import type { VoucherStorage } from '../../ports/voucher-storage';
import { parseNonNegativeAmount } from '../../domain/money';
import { parseVoucherDataUrl } from '../../domain/channel/voucher';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAuditWithinTx } from '../audit';
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
  /** 资金审计（事务参与 port，§5.4/G3——写失败随业务事务回滚） */
  readonly auditTx: AuditTxSink;
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
      // 审计与业务同事务提交前落（§5.4/G3）：只在首次执行写——重放命中同操作
      // 不产生第二条审计（dedupe 后只有一个事实）
      await emitAuditWithinTx(deps.auditTx, tx, {
        actor: 'admin',
        adminId,
        action: 'channel.recharge',
        targetType: 'channel',
        targetId: input.channelId,
        detail: { amount: input.amount, orderNo, hasVoucher: voucherKey != null, remark },
      });
      return { rechargeId, balanceAfter };
    },
  });
  return { ok: true as const, ...receipt, replayed };
}
