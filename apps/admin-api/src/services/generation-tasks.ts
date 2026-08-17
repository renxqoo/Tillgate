import { and, desc, eq, sql } from 'drizzle-orm';
import { billingRequests, generationTasks, usageLogs } from '@ai-gateway/db/schema';
import type { AdminServices } from './index.js';

/**
 * 异步生成任务查询（管理端 service）：
 * 列表 + 关联账单状态/金额（两阶段账本的任务侧观测——预留是否已结算/释放）。
 * 结算金额的权威口径是 usage_logs.amount（结算时写入）。
 */
export interface GenerationTaskRow {
  id: string;
  kind: string;
  status: string;
  userId: number;
  channelId: number;
  upstreamTaskId: string | null;
  failReason: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date;
  /** 关联账单状态（settled=已实扣 / released=已释放不扣 / 其余=在途） */
  billingStatus: string | null;
  /** 结算金额（元；settled 后有值） */
  settledAmount: string | null;
  result: Record<string, unknown> | null;
}

export async function listGenerationTasks(
  s: AdminServices,
  input: { kind?: 'video' | 'music'; status?: string; limit: number; offset: number },
): Promise<{ items: GenerationTaskRow[]; total: number }> {
  const where = and(
    input.kind !== undefined ? eq(generationTasks.kind, input.kind) : undefined,
    input.status !== undefined ? eq(generationTasks.status, input.status) : undefined,
  );
  const rows = await s.db
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
      billingStatus: billingRequests.status,
      result: generationTasks.result,
    })
    .from(generationTasks)
    .leftJoin(billingRequests, eq(billingRequests.requestId, generationTasks.requestId))
    .where(where)
    .orderBy(desc(generationTasks.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  const [countRow] = await s.db
    .select({ count: sql<number>`count(*)::int` })
    .from(generationTasks)
    .where(where);

  const items: GenerationTaskRow[] = [];
  for (const row of rows) {
    let settledAmount: string | null = null;
    if (row.billingStatus === 'settled') {
      const usage = await s.db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, row.id),
        columns: { amount: true },
      });
      settledAmount = usage?.amount ?? null;
    }
    items.push({ ...row, settledAmount });
  }
  return { items, total: Number(countRow?.count ?? 0) };
}
