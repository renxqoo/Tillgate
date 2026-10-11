/**
 * 校准记录 PostgreSQL adapter（prefix_calibrations 表）。
 * 读写均无资金不变量（I0 安全分离）：读空/旧 → 回落保守；写覆盖 → 无累积语义。
 * upsert 主键冲突覆盖；cleanup 按 recent top-keep 驱逐更旧行（幂等）。
 */
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { prefixCalibrations, type Db, type DbTx } from '@tillgate/db';
import type {
  CalibrationStore,
  CalibrationUpsertInput,
} from '../../ports/calibration-store.js';
import type { WalletConn } from '../../ports/wallet-store.js';

function tx(conn: WalletConn): DbTx {
  return conn as unknown as DbTx;
}

/** (user, mapping) 组内 recent top-limit 的 prefix_hash 集（cleanup 保留谓词） */
async function keepHashes(
  conn: WalletConn,
  input: { userId: number; mappingId: number; limit: number },
): Promise<string[]> {
  const rows = await tx(conn)
    .select({ hash: prefixCalibrations.prefixHash })
    .from(prefixCalibrations)
    .where(
      and(
        eq(prefixCalibrations.userId, input.userId),
        eq(prefixCalibrations.mappingId, input.mappingId),
      ),
    )
    .orderBy(desc(prefixCalibrations.settledAt))
    .limit(input.limit);
  return rows.map((r) => r.hash);
}

/** 保留窗最早行（settled_at 并列驱逐兜底的截止时刻） */
async function earliestKeptAt(
  conn: WalletConn,
  input: { userId: number; mappingId: number; hashes: string[] },
): Promise<Date | null> {
  const rows = await tx(conn)
    .select({ settledAt: prefixCalibrations.settledAt })
    .from(prefixCalibrations)
    .where(
      and(
        eq(prefixCalibrations.userId, input.userId),
        eq(prefixCalibrations.mappingId, input.mappingId),
        inArray(prefixCalibrations.prefixHash, input.hashes),
      ),
    )
    .orderBy(prefixCalibrations.settledAt)
    .limit(1);
  return rows[0]?.settledAt ?? null;
}

/** 驱逐不在保留集且不晚于截止时刻的旧行，返回驱逐数（幂等） */
async function evictOlder(
  conn: WalletConn,
  input: { userId: number; mappingId: number; hashes: string[]; cutoff: Date },
): Promise<number> {
  const evicted = await tx(conn)
    .delete(prefixCalibrations)
    .where(
      and(
        eq(prefixCalibrations.userId, input.userId),
        eq(prefixCalibrations.mappingId, input.mappingId),
        notInArray(prefixCalibrations.prefixHash, input.hashes),
        sql`${prefixCalibrations.settledAt} <= ${input.cutoff}`,
      ),
    )
    .returning({ hash: prefixCalibrations.prefixHash });
  return evicted.length;
}

// eslint-disable-next-line max-lines-per-function -- 三个动词的 SQL 平铺（select/insert/驱逐已拆出）
export function createCalibrationStore(_db: Db): CalibrationStore {
  return {
    async findRecent(conn, input) {
      return tx(conn)
        .select({
          userId: prefixCalibrations.userId,
          mappingId: prefixCalibrations.mappingId,
          prefixHash: prefixCalibrations.prefixHash,
          channelId: prefixCalibrations.channelId,
          inputTokens: prefixCalibrations.inputTokens,
          messagesLen: prefixCalibrations.messagesLen,
          settledAt: prefixCalibrations.settledAt,
        })
        .from(prefixCalibrations)
        .where(
          and(
            eq(prefixCalibrations.userId, input.userId),
            eq(prefixCalibrations.mappingId, input.mappingId),
          ),
        )
        .orderBy(desc(prefixCalibrations.settledAt))
        .limit(input.limit);
    },

    async upsert(conn, input: CalibrationUpsertInput) {
      await tx(conn)
        .insert(prefixCalibrations)
        .values({
          userId: input.userId,
          mappingId: input.mappingId,
          prefixHash: input.prefixHash,
          channelId: input.channelId,
          inputTokens: input.inputTokens,
          messagesLen: input.messagesLen,
          requestId: input.requestId,
          settledAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            prefixCalibrations.userId,
            prefixCalibrations.mappingId,
            prefixCalibrations.prefixHash,
          ],
          set: {
            channelId: input.channelId,
            inputTokens: input.inputTokens,
            messagesLen: input.messagesLen,
            requestId: input.requestId,
            settledAt: input.now,
          },
        });
    },

    async cleanup(conn, input) {
      const hashes = await keepHashes(conn, { ...input, limit: input.keep });
      if (hashes.length < input.keep) return 0; // 未超保留数：零变更
      // 双条件驱逐：不在保留集 + 不晚于保留窗最早行（settled_at 并列时 hash 集兜底）
      const cutoff = await earliestKeptAt(conn, { ...input, hashes });
      if (cutoff == null) return 0;
      return evictOlder(conn, { ...input, hashes, cutoff });
    },
  };
}
