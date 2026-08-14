import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Db } from '@ai-gateway/db';
import { traceSpans } from '@ai-gateway/db/schema';
import { dayKey, ensureDailyPartition, listPartitionDays } from './partition.js';
import type { SpanRow, TraceStore, TraceSummary } from './types.js';

/**
 * PG 实现的 trace 存储。
 *
 * 写入：批量 INSERT + 主键 (start_time, span_id) 冲突忽略（SDK 重发幂等）；
 *       按行所在 UTC 日自动 ensure 分区（进程内 memo，每天至多一次 DDL）。
 * 读取：点查走 trace_id/request_id 索引；recent 走 start_time 分区裁剪 + 索引。
 * 数据等级：诊断数据 best-effort——写入失败由调用方（receiver）丢弃并计数，绝不反压。
 */
export function createPgTraceStore(db: Db): TraceStore {
  return {
    async writeBatch(rows) {
      if (rows.length === 0) return 0;
      // 涉及的 UTC 日先确保分区（通常只有 1 天；跨天边界写两个也无害）
      const days = new Set(rows.map((r) => dayKey(r.startTime)));
      for (const day of days) await ensureDailyPartition(db, day);

      const inserted = await db
        .insert(traceSpans)
        .values(
          rows.map((r) => ({
            traceId: r.traceId,
            spanId: r.spanId,
            parentSpanId: r.parentSpanId,
            name: r.name,
            service: r.service,
            startTime: r.startTime,
            endTime: r.endTime,
            durationMs: r.durationMs,
            statusCode: r.statusCode,
            statusMessage: r.statusMessage,
            requestId: r.requestId,
            userId: r.userId,
            channel: r.channel,
            model: r.model,
            attributes: r.attributes,
            events: r.events,
          })),
        )
        .onConflictDoNothing({ target: [traceSpans.startTime, traceSpans.spanId] })
        .returning({ spanId: traceSpans.spanId });
      return inserted.length;
    },

    async findRecentTraces(filter): Promise<TraceSummary[]> {
      const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
      const since = new Date(Date.now() - 24 * 3_600_000);
      // errorsOnly 是 trace 级语义（含 ERROR span 的 trace 全量保留）：
      // 先取含错 traceId 集，再按常规条件取这些 trace 的全部 span
      const errorTraceIds = filter.errorsOnly
        ? db
            .select({ traceId: traceSpans.traceId })
            .from(traceSpans)
            .where(and(gte(traceSpans.startTime, since), eq(traceSpans.statusCode, 2)))
        : undefined;

      const conds = [
        filter.beforeMs ? lt(traceSpans.startTime, new Date(filter.beforeMs)) : undefined,
        filter.service ? eq(traceSpans.service, filter.service) : undefined,
        filter.requestId ? eq(traceSpans.requestId, filter.requestId) : undefined,
        errorTraceIds ? inArray(traceSpans.traceId, errorTraceIds) : undefined,
        // recent 查询限定 24h，命中 start_time 索引 + 分区裁剪
        gte(traceSpans.startTime, since),
      ].filter((c) => c !== undefined);

      const rows = await db
        .select()
        .from(traceSpans)
        .where(and(...conds))
        .orderBy(desc(traceSpans.startTime))
        .limit(limit * 60);

      const byTrace = new Map<string, SpanRow[]>();
      for (const row of rows) {
        const list = byTrace.get(row.traceId) ?? [];
        list.push(row);
        byTrace.set(row.traceId, list);
        if (byTrace.size >= limit) break;
      }

      const summaries: TraceSummary[] = [];
      for (const spans of byTrace.values()) {
        const root =
          spans.find((s) => !s.parentSpanId || !spans.some((o) => o.spanId === s.parentSpanId)) ??
          spans[0]!;
        const durationMs =
          Math.max(...spans.map((s) => s.endTime.getTime())) -
          Math.min(...spans.map((s) => s.startTime.getTime()));
        if (filter.minDurationMs && durationMs < filter.minDurationMs) continue;
        summaries.push({
          traceId: root.traceId,
          rootName: root.name,
          startTimeMs: root.startTime.getTime(),
          durationMs,
          spanCount: spans.length,
          hasError: spans.some((s) => s.statusCode === 2),
          services: [...new Set(spans.map((s) => s.service))],
          requestId: spans.find((s) => s.requestId != null)?.requestId ?? null,
        });
      }
      return summaries.toSorted((a, b) => b.startTimeMs - a.startTimeMs);
    },

    async findByTraceId(traceId) {
      if (!/^[0-9a-f]{1,32}$/i.test(traceId)) return [];
      return db
        .select()
        .from(traceSpans)
        .where(eq(traceSpans.traceId, traceId))
        .orderBy(asc(traceSpans.startTime));
    },

    async findByRequestId(requestId) {
      if (!/^[0-9a-zA-Z-]{1,64}$/.test(requestId)) return [];
      return db
        .select()
        .from(traceSpans)
        .where(and(isNotNull(traceSpans.requestId), eq(traceSpans.requestId, requestId)))
        .orderBy(asc(traceSpans.startTime));
    },

    async stats() {
      const countRow = await db.execute<{ total: string; oldest: Date | null }>(sql`
        select count(*)::text as total, min(start_time) as oldest from trace_spans
      `);
      const row = countRow.rows[0];
      const oldest = row?.oldest ? new Date(row.oldest) : null;
      return {
        spans: Number(row?.total ?? 0),
        oldestDays: oldest
          ? Math.floor((Date.now() - oldest.getTime()) / 86_400_000)
          : null,
        partitions: await listPartitionDays(db),
      };
    },
  };
}
