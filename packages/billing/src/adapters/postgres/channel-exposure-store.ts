/**
 * 渠道进货额度敞口的 PostgreSQL adapter（channels 守卫原子 UPDATE 族 + SQL 侧熔断判定）。
 * 从 billing-store 拆出（聚合边界）。
 */
import { and, eq, sql } from 'drizzle-orm';
import { channels, type Db, type DbTx } from '@tillgate/db';
import type { ChannelExposureStore } from '../../ports/funding-ports.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

// eslint-disable-next-line max-lines-per-function -- 渠道暴露 SQL 构造平铺
export function createChannelExposureStore(_db: Db): ChannelExposureStore {
  return {
    async findChannel(conn: WalletConn, channelId: number) {
      const [row] = await tx(conn)
        .select({
          upstreamBudget: channels.upstreamBudget,
          upstreamReserved: channels.upstreamReserved,
        })
        .from(channels)
        .where(eq(channels.id, channelId));
      return row ?? null;
    },

    async tryIncreaseReserved(
      conn: WalletConn,
      input: { channelId: number; delta: string; now: Date },
    ) {
      const rows = await tx(conn)
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} + ${input.delta}::numeric`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(channels.id, input.channelId),
            sql`${channels.upstreamBudget} - ${channels.upstreamReserved} >= ${input.delta}::numeric`,
          ),
        )
        .returning({
          budget: channels.upstreamBudget,
          reserved: channels.upstreamReserved,
        });
      return rows[0] ?? null;
    },

    async tryDecreaseReserved(
      conn: WalletConn,
      input: { channelId: number; amount: string; now: Date },
    ) {
      const rows = await tx(conn)
        .update(channels)
        .set({
          upstreamReserved: sql`${channels.upstreamReserved} - ${input.amount}::numeric`,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(channels.id, input.channelId),
            sql`${channels.upstreamReserved} >= ${input.amount}::numeric`,
          ),
        )
        .returning({ id: channels.id });
      return rows.length > 0;
    },

    async deductBudgetAndMaybeBreak(
      conn: WalletConn,
      input: { channelId: number; upstreamCost: string; now: Date },
    ) {
      // 熔断判定在 SQL 侧（numeric 精确比较）——JS 侧字符串比较是字典序（'9' <= '10' 为 false）
      const rows = await tx(conn)
        .update(channels)
        .set({
          upstreamBudget: sql`${channels.upstreamBudget} - ${input.upstreamCost}::numeric`,
          updatedAt: input.now,
        })
        .where(eq(channels.id, input.channelId))
        .returning({
          broken: sql<boolean>`(${channels.upstreamBudget} <= coalesce(${channels.upstreamThreshold}, 0))`,
        });
      const [row] = rows;
      if (!row) return false;
      if (row.broken) {
        await tx(conn)
          .update(channels)
          .set({ status: 3, updatedAt: input.now })
          .where(and(eq(channels.id, input.channelId), eq(channels.status, 0)));
        return true;
      }
      return false;
    },

    async recordUsageDefect(conn, input) {
      // 原子计数 + SQL 侧阈值判定（避免 JS 读改写竞态；同 deduct 的熔断语义）
      const rows = await tx(conn)
        .update(channels)
        .set({
          usageEvidenceDefects: sql`${channels.usageEvidenceDefects} + 1`,
          updatedAt: input.now,
        })
        .where(eq(channels.id, input.channelId))
        .returning({
          defects: channels.usageEvidenceDefects,
          alreadyBroken: sql<boolean>`${channels.status} <> 0`,
        });
      const [row] = rows;
      if (!row) return null;
      if (!row.alreadyBroken && row.defects >= input.threshold) {
        await tx(conn)
          .update(channels)
          .set({ status: 3, updatedAt: input.now })
          .where(and(eq(channels.id, input.channelId), eq(channels.status, 0)));
        return { defects: row.defects, broken: true };
      }
      return { defects: row.defects, broken: false };
    },
  };
}
