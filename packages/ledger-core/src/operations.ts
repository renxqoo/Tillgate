/**
 * 幂等操作动词（一动词一事）：
 *
 *   run        首执行 → INSERT（唯一键占位）→ execute(tx) → 回执落档，同一事务
 *              重放   → INSERT 0 行 → 读回 → 指纹/类型核对 → 原样归还回执
 *              冲突   → 指纹或类型与存档不符 → OperationConflictError（串号事故的闸）
 *   operation  单条查询
 *   operations 游标分页（id 倒序）
 *
 * 并发语义（无 advisory lock，靠唯一索引单语句定序）：两个同键 run 并发，
 * 后到者的 INSERT 阻塞在唯一索引上直到先到者事务终结——提交则读回重放，
 * 回滚则接棒执行。不存在「读到未提交半成品」的窗口。
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { InvalidInputError, LedgerInternalError, OperationConflictError } from './errors.js';
import { canonicalJson, fingerprintOf } from './fingerprint.js';
import { runEffect, runTx, type DbLike, type Tx } from './internal.js';
import { ledgerOperations } from './schema.js';
import { assertOperationId, guardKind, type ValidationGuards } from './validation.js';
import type {
  LedgerEffects,
  ListOperationsInput,
  ListOperationsResult,
  OperationReceipt,
  OperationView,
  RunOperationInput,
  RunOperationResult,
} from './types.js';

/** 回执 canonical 序列化上限（16KB）——回执是重放归还物，超档应拆业务表 */
const MAX_RECEIPT_BYTES = 16_384;

interface StoredRow {
  id: number;
  operationId: string;
  kind: string;
  fingerprint: string;
  receipt: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function validateReceipt(receipt: unknown): void {
  if (receipt !== null && (typeof receipt !== 'object' || Array.isArray(receipt))) {
    throw new InvalidInputError('receipt', 'must be a plain object or null');
  }
  let serialized: string;
  try {
    serialized = canonicalJson(receipt);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      throw new InvalidInputError('receipt', error.detail);
    }
    throw error;
  }
  if (serialized.length > MAX_RECEIPT_BYTES) {
    throw new InvalidInputError('receipt', `serialized size must be <= ${MAX_RECEIPT_BYTES} bytes`);
  }
}

function toView(row: StoredRow): OperationView {
  return {
    operationId: row.operationId,
    kind: row.kind,
    fingerprint: row.fingerprint,
    receipt: (row.receipt as OperationReceipt | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function runOperation<T extends OperationReceipt | null>(
  db: NodePgDatabase,
  input: RunOperationInput<T>,
  guards: ValidationGuards,
  effects: LedgerEffects | undefined,
): Promise<RunOperationResult<T>> {
  const operationId = assertOperationId(input?.operationId);
  const kind = guardKind(input?.kind, guards);
  if (typeof input?.execute !== 'function') {
    throw new InvalidInputError('execute', 'must be a function');
  }
  // 指纹在事务外计算：值合法性与 execute 无关，坏输入不允许进事务
  let fingerprint: string;
  try {
    fingerprint = fingerprintOf(input.fingerprint);
  } catch (error) {
    if (error instanceof InvalidInputError) {
      throw new InvalidInputError('fingerprint', error.detail);
    }
    throw error;
  }

  const exec = async (tx: DbLike): Promise<RunOperationResult<T>> => {
    const inserted = await tx
      .insert(ledgerOperations)
      .values({ operationId, kind, fingerprint })
      .onConflictDoNothing({ target: ledgerOperations.operationId })
      .returning({ id: ledgerOperations.id, createdAt: ledgerOperations.createdAt });

    if (inserted.length === 0) {
      // 同键已存在（并发对手已提交或历史已执行）：读回核对后重放或冲突
      const existing = await tx
        .select()
        .from(ledgerOperations)
        .where(eq(ledgerOperations.operationId, operationId))
        .limit(1);
      const row = existing[0];
      if (!row) {
        throw new LedgerInternalError('run_operation', 'unique conflict but readback found no row');
      }
      if (row.kind !== kind) {
        throw new OperationConflictError(operationId, 'kind_mismatch', row.kind, kind);
      }
      if (row.fingerprint !== fingerprint) {
        throw new OperationConflictError(operationId, 'fingerprint_mismatch', row.kind, kind);
      }
      if (row.receipt === undefined) {
        throw new LedgerInternalError('run_operation', 'committed operation has undefined receipt');
      }
      return {
        operationId,
        kind,
        receipt: (row.receipt ?? null) as T,
        replayed: true,
        createdAt: row.createdAt.toISOString(),
      };
    }

    // 首执行：业务状态机 + 钱动词（tx 由 execute 持有）；回执校验后同事务落档
    const receipt = await input.execute(tx as Tx);
    validateReceipt(receipt);
    await tx
      .update(ledgerOperations)
      .set({ receipt: receipt as OperationReceipt | null, updatedAt: sql`now()` })
      .where(eq(ledgerOperations.operationId, operationId));
    return {
      operationId,
      kind,
      receipt,
      replayed: false,
      createdAt: inserted[0]!.createdAt.toISOString(),
    };
  };

  const result = input.tx != null ? await exec(input.tx) : await runTx(db, exec);

  await runEffect(() =>
    effects?.committed?.({
      operationId,
      kind,
      replayed: result.replayed,
      receipt: (result.receipt as OperationReceipt | null) ?? null,
    }),
  );
  await runEffect(() =>
    effects?.audit?.({
      actor: 'system',
      action: result.replayed ? 'operation.replay' : 'operation.execute',
      targetType: 'operation',
      targetId: operationId,
      detail: { kind },
    }),
  );
  return result;
}

export async function getOperation(
  db: NodePgDatabase,
  input: { operationId: string },
): Promise<OperationView | null> {
  const operationId = assertOperationId(input?.operationId);
  const rows = await db
    .select()
    .from(ledgerOperations)
    .where(eq(ledgerOperations.operationId, operationId))
    .limit(1);
  const row = rows[0] as StoredRow | undefined;
  return row ? toView(row) : null;
}

export async function listOperations(
  db: NodePgDatabase,
  input: ListOperationsInput = {},
): Promise<ListOperationsResult> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new InvalidInputError('limit', 'must be an integer in [1, 200]');
  }
  if (input.kind !== undefined && typeof input.kind !== 'string') {
    throw new InvalidInputError('kind', 'must be a string when provided');
  }
  const cursorId =
    input.cursor !== undefined ? parseCursor(input.cursor) : Number.MAX_SAFE_INTEGER;

  const conditions = [lt(ledgerOperations.id, cursorId)];
  if (input.kind !== undefined) {
    conditions.push(eq(ledgerOperations.kind, input.kind));
  }
  const rows = (await db
    .select()
    .from(ledgerOperations)
    .where(and(...conditions))
    .orderBy(desc(ledgerOperations.id))
    .limit(limit + 1)) as StoredRow[];

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    items: page.map(toView),
    nextCursor: hasMore ? String(page[page.length - 1]!.id) : null,
  };
}

/** 游标=行 id 的字符串形态（不透明契约：只回传不解析语义） */
function parseCursor(cursor: string): number {
  if (typeof cursor !== 'string' || !/^[0-9]{1,16}$/.test(cursor)) {
    throw new InvalidInputError('cursor', 'must be the nextCursor value returned by a previous page');
  }
  const value = Number(cursor);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new InvalidInputError('cursor', 'must be a positive integer row cursor');
  }
  return value;
}
