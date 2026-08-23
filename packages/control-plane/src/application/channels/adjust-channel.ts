/**
 * 渠道调账（幂等）：budget += amount（可负）；守卫 = 调后不得为负。
 * 0 行二义（渠道不存在 vs 守卫未过）在事务内二次读消解。
 * 审计与业务同事务（§5.4/G3）：写失败随事务回滚。
 */
import type { Db } from '@tokenlens/db';
import type { AuditTxSink } from '../../ports/audit-sink';
import type { ChannelStore } from '../../ports/channel-store';
import type { OperationsStore } from '../../ports/operations-store';
import { parseSignedNonZeroAmount } from '../../domain/money';
import { controlPlaneErrors } from '../../errors';
import { adminIdOf, type ControlContext } from '../context';
import { emitAuditWithinTx } from '../audit';
import { runOperation, type RunOperationDeps } from './run-operation';

export interface AdjustChannelDeps extends RunOperationDeps {
  readonly db: Db;
  readonly stores: {
    readonly channel: ChannelStore;
    readonly operations: OperationsStore;
  };
  /** 资金审计（事务参与 port，§5.4/G3——写失败随业务事务回滚） */
  readonly auditTx: AuditTxSink;
}

export interface AdjustChannelInput {
  readonly ctx: ControlContext;
  readonly channelId: number;
  readonly amount: string;
  readonly remark?: string | null;
  readonly operationId: string;
}

export interface AdjustChannelResult {
  readonly ok: true;
  readonly rechargeId: number;
  readonly balanceAfter: string;
  readonly replayed: boolean;
}

export async function adjustChannel(
  deps: AdjustChannelDeps,
  input: AdjustChannelInput,
): Promise<AdjustChannelResult> {
  if (parseSignedNonZeroAmount(input.amount) == null) {
    throw controlPlaneErrors.business('invalid_channel_input', { amount: input.amount });
  }
  const remark = input.remark?.trim() || null;
  const adminId = adminIdOf(input.ctx);
  if (adminId == null) {
    throw controlPlaneErrors.business('invalid_channel_input', { actor: 'not_admin' });
  }

  const { receipt, replayed } = await runOperation(deps, {
    ctx: input.ctx,
    operationId: input.operationId,
    kind: 'channel.adjust',
    payload: {
      kind: 'channel.adjust',
      channelId: input.channelId,
      amount: input.amount,
      remark,
      adminId,
    },
    execute: async (tx) => {
      const outcome = await deps.stores.channel.tryAdjustBudget(tx, {
        channelId: input.channelId,
        amount: input.amount,
        now: new Date(),
      });
      if (!outcome.ok) {
        // 0 行二义：渠道不存在 vs 守卫未过（调后为负）
        const channel = await deps.stores.channel.findChannelFunds(tx, input.channelId);
        if (!channel) {
          throw controlPlaneErrors.business('channel_not_found', { channelId: input.channelId });
        }
        throw controlPlaneErrors.business('insufficient_budget', {
          channelId: input.channelId,
          budget: channel.upstreamBudget,
        });
      }
      const rechargeId = await deps.stores.channel.insertRecharge(tx, {
        channelId: input.channelId,
        type: 'adjust',
        amount: input.amount,
        balanceAfter: outcome.budget,
        orderNo: null,
        voucher: null,
        remark,
        adminId,
      });
      // 审计与业务同事务提交前落（§5.4/G3）：重放不产生第二条审计（dedupe）
      await emitAuditWithinTx(deps.auditTx, tx, {
        actor: 'admin',
        adminId,
        action: 'channel.adjust',
        targetType: 'channel',
        targetId: input.channelId,
        detail: { amount: input.amount, remark },
      });
      return { rechargeId, balanceAfter: outcome.budget };
    },
  });
  return { ok: true as const, ...receipt, replayed };
}
