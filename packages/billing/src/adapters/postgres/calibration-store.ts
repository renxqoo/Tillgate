/**
 * 校准记录 PostgreSQL adapter（prefix_calibrations 表）。
 * 读写均无资金不变量（I0 安全分离）：读空/旧 → 回落保守；写覆盖 → 无累积语义。
 * upsert 主键冲突覆盖；cleanup 按 recent top-keep 驱逐更旧行（幂等）。
 */
import { and, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import { prefixCalibrations, type Db, type DbTx } from '@tillgate/db';
import type { CalibrationStore, CalibrationUpsertInput } from '../../ports/calibration-store.js';
import type { WalletConn } from '../../ports/wallet-store.js';

/**
 * 连接解析：外部 conn 优先（事务/读路径注入）；缺省回落 store 自持 db
 * （P5：worker retention 等无事务上下文的调用方——undefined conn 在
 * postgres 适配器上会 TypeError 且被 best-effort 链静默吞掉）。
 */
function connOf(db: Db, conn: WalletConn | undefined): DbTx {
  if (conn != null) return conn as unknown as DbTx;
  return db as unknown as DbTx;
}

/** (user, mapping) 组内 recent top-limit 的 prefix_hash 集（cleanup 保留谓词） */
/** 内部查询的 conn 形状（解析后） */
async function keepHashes(
  db: Db,
  conn: WalletConn | undefined,
  input: { userId: number; mappingId: number; limit: number },
): Promise<string[]> {
  const rows = await connOf(db, conn)
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
  db: Db,
  conn: WalletConn | undefined,
  input: { userId: number; mappingId: number; hashes: string[] },
): Promise<Date | null> {
  const rows = await connOf(db, conn)
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
  db: Db,
  conn: WalletConn | undefined,
  input: { userId: number; mappingId: number; hashes: string[]; cutoff: Date },
): Promise<number> {
  const evicted = await connOf(db, conn)
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
export function createCalibrationStore(db: Db): CalibrationStore {
  return {
    async findRecent(conn, input) {
      return connOf(db, conn)
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
      await connOf(db, conn)
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
      const hashes = await keepHashes(db, conn, { ...input, limit: input.keep });
      if (hashes.length < input.keep) return 0; // 未超保留数：零变更
      // 双条件驱逐：不在保留集 + 不晚于保留窗最早行（settled_at 并列时 hash 集兜底）
      const cutoff = await earliestKeptAt(db, conn, { ...input, hashes });
      if (cutoff == null) return 0;
      return evictOlder(db, conn, { ...input, hashes, cutoff });
    },
  };
}
