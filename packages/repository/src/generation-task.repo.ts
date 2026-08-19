/**
 * 生成任务仓储：generation_tasks 的全部 SQL（提交落库/归属查询/轮询认领/超时扫描/CAS 终态）。
 *
 * 资金单一真相在 billing_requests（提交=authorize 预留 → 终态=signal 实扣/释放）；
 * 本表只承载任务生命周期与产物。终态迁移一律 CAS（在途状态集合内 0 行命中 =
 * 他副本已处理——幂等），任务迁移与产物/原因同 UPDATE 写入（终态一致性 CHECK）。
 */
import { and, asc, desc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { billingRequests, generationTasks, usageLogs } from '@ai-gateway/db';
import type { RepoContext } from './context.js';

export type GenerationTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'expired';

export interface GenerationTaskRow {
  id: string;
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  mappingId: number;
  channelId: number;
  upstreamTaskId: string | null;
  kind: string;
  status: GenerationTaskStatus;
  params: Record<string, unknown>;
  receiptTemplate: Record<string, unknown>;
  unitsSnapshot: string | null;
  result: Record<string, unknown> | null;
  failReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  finishedAt: Date | null;
}

/** 提交落库形状（收据模板 + 计量快照由调用方定型——不让 worker 反解 quote） */
export interface InsertGenerationTask {
  id: string;
  requestId: string;
  userId: number;
  apiKeyId: number | null;
  mappingId: number;
  channelId: number;
  upstreamTaskId: string | null;
  kind: 'video' | 'music';
  params: Record<string, unknown>;
  receiptTemplate: Record<string, unknown>;
  unitsSnapshot: string;
  expiresAt: Date;
  now: Date;
}

const TASK_COLUMNS = {
  id: generationTasks.id,
  requestId: generationTasks.requestId,
  userId: generationTasks.userId,
  apiKeyId: generationTasks.apiKeyId,
  mappingId: generationTasks.mappingId,
  channelId: generationTasks.channelId,
  upstreamTaskId: generationTasks.upstreamTaskId,
  kind: generationTasks.kind,
  status: generationTasks.status,
  params: generationTasks.params,
  receiptTemplate: generationTasks.receiptTemplate,
  unitsSnapshot: generationTasks.unitsSnapshot,
  result: generationTasks.result,
  failReason: generationTasks.failReason,
  createdAt: generationTasks.createdAt,
  updatedAt: generationTasks.updatedAt,
  expiresAt: generationTasks.expiresAt,
  finishedAt: generationTasks.finishedAt,
};

/** 生成任务仓储（无状态；方法统一接收 RepoContext——事务由用例层注入） */
export class GenerationTaskRepository {
  /** 提交落库（id 主键 = billing requestId——幂等冲突由唯一约束抛错上浮） */
  async insert(c: RepoContext, input: InsertGenerationTask): Promise<void> {
    await c.db.insert(generationTasks).values({
      id: input.id,
      requestId: input.requestId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      mappingId: input.mappingId,
      channelId: input.channelId,
      upstreamTaskId: input.upstreamTaskId,
      kind: input.kind,
      status: 'queued',
      params: input.params,
      receiptTemplate: input.receiptTemplate,
      unitsSnapshot: input.unitsSnapshot,
      expiresAt: input.expiresAt,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /** 归属查询（他人任务一律 null——调用方按不存在处理，不暴露存在性） */
  async findByOwner(
    c: RepoContext,
    input: { id: string; userId: number },
  ): Promise<GenerationTaskRow | null> {
    const [row] = await c.db
      .select(TASK_COLUMNS)
      .from(generationTasks)
      .where(and(eq(generationTasks.id, input.id), eq(generationTasks.userId, input.userId)));
    return (row as GenerationTaskRow) ?? null;
  }

  /** 轮询认领：指定类型族的在途任务，createdAt 升序限量（超时扫描权威源是 expires_at） */
  async listActiveByKinds(
    c: RepoContext,
    input: {
      kinds: readonly string[];
      statuses: readonly GenerationTaskStatus[];
      batch: number;
      /** 翻页游标（上一页最后一行的 createdAt ISO——首批缺省）。无游标的「limit N」
       *  形态下第 N+1 个任务永远轮不到探测（队头饥饿：TTL 到期被误判超时释放） */
      afterCreatedAt?: string;
    },
  ): Promise<GenerationTaskRow[]> {
    if (input.kinds.length === 0 || input.statuses.length === 0) return [];
    const rows = await c.db
      .select(TASK_COLUMNS)
      .from(generationTasks)
      .where(
        and(
          inArray(generationTasks.kind, [...input.kinds]),
          inArray(generationTasks.status, [...input.statuses]),
          ...(input.afterCreatedAt
            ? [gt(generationTasks.createdAt, new Date(input.afterCreatedAt))]
            : []),
        ),
      )
      .orderBy(asc(generationTasks.createdAt))
      .limit(input.batch);
    return rows as GenerationTaskRow[];
  }

  /** 用户在途任务数（准入闸——无上限时单用户可占满轮询批次并压住他人任务的终态时延） */
  async countActiveByUser(c: RepoContext, userId: number): Promise<number> {
    const [row] = await c.db
      .select({ count: sql<number>`count(*)::int` })
      .from(generationTasks)
      .where(
        and(
          eq(generationTasks.userId, userId),
          inArray(generationTasks.status, ['queued', 'running']),
        ),
      );
    return row?.count ?? 0;
  }

  /** 超时扫描：批量 CAS 在途→expired（权威时间源 expires_at ≤ 库端 clock_timestamp），返回待释放信号行 */
  async expireOverdue(
    c: RepoContext,
    input: { reason: string },
  ): Promise<Array<{ id: string; requestId: string }>> {
    const rows = await c.db
      .update(generationTasks)
      .set({
        status: 'expired',
        failReason: input.reason,
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          inArray(generationTasks.status, ['queued', 'running']),
          lte(generationTasks.expiresAt, sql`clock_timestamp()`),
        ),
      )
      .returning({ id: generationTasks.id, requestId: generationTasks.requestId });
    return rows;
  }

  /** queued → running 状态同步（非终态，无 CAS 竞争——仅 0/1 行迁移） */
  async markRunning(c: RepoContext, id: string): Promise<void> {
    await c.db
      .update(generationTasks)
      .set({ status: 'running', updatedAt: sql`clock_timestamp()` })
      .where(and(eq(generationTasks.id, id), eq(generationTasks.status, 'queued')));
  }

  /** 终态 CAS：仅在途集合内迁移；false = 他副本已终态化（幂等跳过） */
  async casTerminal(
    c: RepoContext,
    input: {
      id: string;
      status: 'succeeded' | 'failed' | 'expired';
      result?: Record<string, unknown>;
      failReason?: string;
    },
  ): Promise<boolean> {
    const rows = await c.db
      .update(generationTasks)
      .set({
        status: input.status,
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.failReason !== undefined ? { failReason: input.failReason } : {}),
        finishedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(eq(generationTasks.id, input.id), inArray(generationTasks.status, ['queued', 'running'])),
      )
      .returning({ id: generationTasks.id });
    return rows.length > 0;
  }

  // ── 管理面 ──────────────────────────────────────────────────────────────────

  /** 管理列表：kind/status 过滤 + 账单状态 join（limit/offset 风格——运维翻页） */
  async listAdminTasks(
    c: RepoContext,
    input: { kind?: 'video' | 'music'; status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'expired'; limit: number; offset: number },
  ): Promise<{ rows: unknown[]; total: number }> {
    const conditions = [];
    if (input.kind) conditions.push(eq(generationTasks.kind, input.kind));
    if (input.status) conditions.push(eq(generationTasks.status, input.status));
    const where = conditions.length ? and(...conditions) : undefined;
    const [rows, countRows] = await Promise.all([
      c.db
        .select({
          id: generationTasks.id,
          kind: generationTasks.kind,
          status: generationTasks.status,
          userId: generationTasks.userId,
          channelId: generationTasks.channelId,
          upstreamTaskId: generationTasks.upstreamTaskId,
          failReason: generationTasks.failReason,
          createdAt: generationTasks.createdAt,
          finishedAt: generationTasks.finishedAt,
          expiresAt: generationTasks.expiresAt,
          result: generationTasks.result,
          billingStatus: billingRequests.status,
        })
        .from(generationTasks)
        .leftJoin(billingRequests, eq(billingRequests.requestId, generationTasks.requestId))
        .where(where)
        .orderBy(desc(generationTasks.createdAt))
        .limit(input.limit)
        .offset(input.offset),
      c.db
        .select({ count: sql<number>`count(*)::int` })
        .from(generationTasks)
        .where(where),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }

  /** 已结算任务的实扣金额（页内批量——消除 N+1；task.id 即计费 requestId 惯例） */
  async findSettledAmounts(
    c: RepoContext,
    requestIds: readonly string[],
  ): Promise<Map<string, string>> {
    if (requestIds.length === 0) return new Map();
    const rows = await c.db
      .select({ requestId: usageLogs.requestId, amount: usageLogs.amount })
      .from(usageLogs)
      .where(inArray(usageLogs.requestId, [...requestIds]));
    return new Map(rows.map((r) => [r.requestId, r.amount]));
  }
}
