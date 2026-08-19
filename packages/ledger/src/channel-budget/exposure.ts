/**
 * channel-budget/exposure：上游敞口预留/释放（S4，自 billing/channel-reserve 上移，行为零变更）。
 *
 * 渠道「进货额度」精确硬闸：选渠前原子预留在途上游成本敞口（官方价口径）。
 * 所有守卫内联在 UPDATE WHERE（R4：check-then-act 并发超扣）。
 *
 * 变更顺序不变量（换渠道路径）：先守卫预留新渠道 → 再释放旧渠道 → 最后 CAS
 * 认领账单行。任何早退（拒绝）都发生在零变更状态——「先释放后预留」的旧顺序
 * 在守卫预留输掉并发时会提交孤儿释放（敞口少记 + 结算二次释放偷走他人敞口）。
 * 认领 CAS（channel_id + channel_reserved_amount 等于读到的旧值）让并发同请求
 * 双切换在结构上不可能产生孤儿敞口：输家 CAS 落空 → 整体回滚。
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { billingRequests, channels } from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { BillingConfigurationError, BillingInvariantError, BillingStateConflictError } from '../platform/errors.js';
import type { ChannelReservationResult, ReserveChannelCommand } from './types.js';

export async function reserveExposure(
  db: Db,
  clock: () => Date,
  command: ReserveChannelCommand,
): Promise<ChannelReservationResult> {
  const now = clock();
  const amount = toDecimal(command.amount);
  if (!amount.isFinite() || amount.lt(0)) {
    throw new BillingConfigurationError('invalid_quote');
  }
  return db.transaction(async (tx) => {
    const br = await tx.query.billingRequests.findFirst({
      where: eq(billingRequests.requestId, command.requestId),
      columns: {
        status: true,
        channelId: true,
        channelReservedAmount: true,
      },
    });
    if (!br) {
      throw new BillingStateConflictError(command.requestId, 'billing request missing');
    }
    if (!['authorized', 'in_flight'].includes(br.status)) {
      return { allowed: false, remaining: '0', switched: false };
    }
    // 认领守卫：状态可预留 + 渠道投影仍是本次读到的旧值（CAS——并发同请求
    // 预留/换渠道的输家在此落空并整体回滚，敞口不会孤儿化）。
    const claimGuard = and(
      eq(billingRequests.requestId, command.requestId),
      inArray(billingRequests.status, ['authorized', 'in_flight']),
      br.channelId == null
        ? isNull(billingRequests.channelId)
        : eq(billingRequests.channelId, br.channelId),
      br.channelReservedAmount == null
        ? isNull(billingRequests.channelReservedAmount)
        : eq(billingRequests.channelReservedAmount, br.channelReservedAmount),
    );
    // 同渠道重复预留：金额不大于已留 → 幂等放行；更大 → 按差额补足（F3：
    // fallback 模型预估更高路由回同一渠道，敞口必须从 5 补到 8，否则预算闸门
    // 被弱化；预算不足则拒绝（调用方换渠道）。账单 channelReservedAmount 同步新值。
    if (br.channelId === command.channelId && br.channelReservedAmount != null) {
      const delta = amount.minus(toDecimal(br.channelReservedAmount));
      if (delta.lte(0)) {
        return { allowed: true, remaining: '0', switched: false };
      }
      const topped = await tx
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} + ${delta.toString()}::numeric`,
          updatedAt: now,
        })
        .where(
          sql`${channels.id} = ${command.channelId}
              and ${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${delta.toString()}::numeric`,
        )
        .returning({
          budget: channels.upstreamBudget,
          reserved: channels.upstreamReserved,
        });
      if (topped.length === 0) {
        const chNow = await tx.query.channels.findFirst({
          where: eq(channels.id, command.channelId),
          columns: { upstreamBudget: true, upstreamReserved: true },
        });
        return {
          allowed: false,
          remaining: chNow
            ? toDecimal(chNow.upstreamBudget).minus(toDecimal(chNow.upstreamReserved)).toString()
            : '0',
          switched: false,
        };
      }
      const claimedTopup = await tx
        .update(billingRequests)
        .set({ channelReservedAmount: amount.toString(), updatedAt: now })
        .where(claimGuard)
        .returning({ requestId: billingRequests.requestId });
      if (claimedTopup.length === 0) {
        throw new BillingStateConflictError(command.requestId, 'reserve target not reservable');
      }
      return {
        allowed: true,
        remaining: toDecimal(topped[0]!.budget).minus(toDecimal(topped[0]!.reserved)).toString(),
        switched: false,
      };
    }

    // 目标渠道：按「余额 = 进货额度（当前余额，结算已扣减）- 在途敞口」校验是否有钱。
    // 此读仅为快速路径与提示信息；权威闸门在下方 UPDATE 的 WHERE（R4）。
    const ch = await tx.query.channels.findFirst({
      where: eq(channels.id, command.channelId),
      columns: { upstreamBudget: true, upstreamReserved: true },
    });
    if (!ch) return { allowed: false, remaining: '0', switched: false };
    const remaining = toDecimal(ch.upstreamBudget).minus(toDecimal(ch.upstreamReserved));
    if (remaining.lt(amount)) {
      // 余额不足 → 拒绝；不释放旧渠道敞口（保持可回退，最终失败由 signal 释放）
      return { allowed: false, remaining: remaining.toString(), switched: false };
    }

    // 原子预留（第一个变更）：余额守卫内联在 UPDATE 的 WHERE——并发对手在检查
    // 与写入之间占走余额时此条件更新命中 0 行 → 零变更拒绝（allowed:false）。
    const reservedNow = await tx
      .update(channels)
      .set({
        upstreamReserved: sql`${channels.upstreamReserved} + ${amount.toString()}::numeric`,
        updatedAt: now,
      })
      .where(
        sql`${channels.id} = ${command.channelId}
            and ${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${amount.toString()}::numeric`,
      )
      .returning({
        budget: channels.upstreamBudget,
        reserved: channels.upstreamReserved,
      });
    if (reservedNow.length === 0) {
      return { allowed: false, remaining: '0', switched: false };
    }

    // 换渠道（fallback）：预留成功后才释放旧渠道敞口（守卫失败 → 抛错回滚新预留）。
    let switched = false;
    if (
      br.channelId != null &&
      br.channelId !== command.channelId &&
      br.channelReservedAmount != null
    ) {
      const released = await tx
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} - ${br.channelReservedAmount}::numeric`,
          updatedAt: now,
        })
        .where(
          sql`${channels.id} = ${br.channelId}
              and ${channels.upstreamReserved} >= ${br.channelReservedAmount}::numeric`,
        )
        .returning({ id: channels.id });
      if (released.length === 0) throw new BillingInvariantError('channel_reservation_invariant');
      switched = true;
    }

    // 认领账单行（最后一个变更）：状态守卫 + 渠道投影 CAS。与过期回收
    // （recoverOnce）或并发同请求预留竞态时 0 行命中 → 抛错回滚整个事务。
    const claimed = await tx
      .update(billingRequests)
      .set({
        channelId: command.channelId,
        channelReservedAmount: amount.toString(),
        updatedAt: now,
      })
      .where(claimGuard)
      .returning({ requestId: billingRequests.requestId });
    if (claimed.length === 0) {
      throw new BillingStateConflictError(command.requestId, 'reserve target not reservable');
    }
    const remainingAfter = toDecimal(reservedNow[0]!.budget).minus(
      toDecimal(reservedNow[0]!.reserved),
    );
    return { allowed: true, remaining: remainingAfter.toString(), switched };
  });
}
