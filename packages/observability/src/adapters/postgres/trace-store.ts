import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '@tillgate/db';
import { traceSpans } from '@tillgate/db';
import { dayKey } from '../../tracing/partition';
import type { TraceStore, TraceSummary } from '../../tracing/types';
import { ensureTracePartition, listTracePartitionDays } from './trace-partitions';

/**
 * PG 实现的 trace 存储。
 *
 * 写入:批量 INSERT + 主键 (start_time, span_id) 冲突忽略(SDK 重发幂等);
 *       按行所在 UTC 日自动 ensure 分区(进程内 memo,每天至多一次 DDL——G4:闭包持有)。
 * 读取:点查走 trace_id/request_id 索引;recent 走 start_time 分区裁剪 + 索引。
 * 数据等级:诊断数据 best-effort——写入失败由调用方(接收端 batcher)丢弃并计数,绝不反压。
 */
export function createPgTraceStore(db: Db): TraceStore {
  const ensured = new Set<string>();

  return {
    async writeBatch(rows) {
      if (rows.length === 0) return 0;
      // 涉及的 UTC 日先确保分区(通常只有 1 天;跨天边界写两个也无害)
      const days = new Set(rows.map((r) => dayKey(r.startTime)));
      for (const day of days) {
        if (ensured.has(day)) continue;
        await ensureTracePartition(db, day);
        ensured.add(day);
      }

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
            // 派生值存储端重算:duration 必须与起止一致(单一真相)
            durationMs: r.endTime.getTime() - r.startTime.getTime(),
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
      const limit = Math.min(100, Math.max(1, filter.limit ?? 50));
      const offset = Math.max(0, filter.offset ?? 0);
      const since = new Date(Date.now() - 24 * 3_600_000);
      // errorsOnly 是 trace 级语义(含 ERROR span 的 trace 全量保留)
      const errorTraceIds = filter.errorsOnly
        ? db
            .select({ traceId: traceSpans.traceId })
            .from(traceSpans)
            .where(and(gte(traceSpans.startTime, since), eq(traceSpans.statusCode, 2)))
        : undefined;

      // recent 查询限定 24h,命中 start_time 索引 + 分区裁剪
      const conds = [
        filter.service ? eq(traceSpans.service, filter.service) : undefined,
        filter.requestId ? eq(traceSpans.requestId, filter.requestId) : undefined,
        errorTraceIds ? inArray(traceSpans.traceId, errorTraceIds) : undefined,
        gte(traceSpans.startTime, since),
      ].filter((c) => c !== undefined);
      const where = and(...conds);
      // trace 级时长 = max(end) - min(start);下限过滤走 HAVING(数据库完成)
      const having = filter.minDurationMs
        ? sql`(extract(epoch from (max(${traceSpans.endTime}) - min(${traceSpans.startTime}))) * 1000) >= ${filter.minDurationMs}`
        : undefined;

      // 聚合数组用 array_to_json 显式序列化(drizzle 下 PG 数组以字符串返回,
      // 不能依赖驱动端解析;JSON 是唯一确定性的传输格式)。
      // requestIds 与 names 同序(order by start_time)——summary.requestId 取最早 span 的值(B4)
      const rows = await db
        .select({
          traceId: traceSpans.traceId,
          names: sql<
            string[]
          >`array_to_json(array_agg(${traceSpans.name} order by ${traceSpans.startTime}))`,
          startTimes: sql<
            string[]
          >`array_to_json(array_agg(${traceSpans.startTime} order by ${traceSpans.startTime}))`,
          endTimes: sql<string[]>`array_to_json(array_agg(${traceSpans.endTime}))`,
          minStart: sql<string>`min(${traceSpans.startTime})`,
          parentIds: sql<
            Array<string | null>
          >`array_to_json(array_agg(${traceSpans.parentSpanId} order by ${traceSpans.startTime}))`,
          spanIds: sql<
            string[]
          >`array_to_json(array_agg(${traceSpans.spanId} order by ${traceSpans.startTime}))`,
          services: sql<string[]>`array_to_json(array_agg(distinct ${traceSpans.service}))`,
          requestIds: sql<
            Array<string | null>
          >`array_to_json(array_agg(${traceSpans.requestId} order by ${traceSpans.startTime}))`,
          spanCount: sql<number>`count(*)::int`,
          hasError: sql<boolean>`bool_or(${traceSpans.statusCode} = 2)`,
        })
        .from(traceSpans)
        .where(where)
        .groupBy(traceSpans.traceId)
        .having(having)
        .orderBy(desc(sql`min(${traceSpans.startTime})`), desc(traceSpans.traceId))
        .limit(limit)
        .offset(offset);

      return rows.map((r) => {
        const names = r.names;
        const startTimes = r.startTimes;
        const endTimes = r.endTimes;
        const parentIds = r.parentIds;
        const spanIds = r.spanIds;
        const requestIds = r.requestIds;
        // root:第一个 parent 不在本 trace span 集内的 span(与旧逐行分组语义一致)
        const spanIdSet = new Set(spanIds);
        let rootIdx = names.findIndex((_, i) => {
          const parent = parentIds[i];
          return !parent || !spanIdSet.has(parent);
        });
        if (rootIdx < 0) rootIdx = 0;
        const startMs = new Date(startTimes[rootIdx]!).getTime();
        const endMs = Math.max(...endTimes.map((t) => new Date(t).getTime()));
        return {
          traceId: r.traceId,
          rootName: names[rootIdx]!,
          startTimeMs: startMs,
          durationMs: endMs - new Date(r.minStart).getTime(),
          spanCount: r.spanCount,
          hasError: r.hasError,
          services: [...new Set(r.services)],
          requestId: requestIds.find((id) => id != null) ?? null,
        };
      });
    },

    async countRecentTraces(filter) {
      const since = new Date(Date.now() - 24 * 3_600_000);
      const errorTraceIds = filter.errorsOnly
        ? db
            .select({ traceId: traceSpans.traceId })
            .from(traceSpans)
            .where(and(gte(traceSpans.startTime, since), eq(traceSpans.statusCode, 2)))
        : undefined;
      const conds = [
        filter.service ? eq(traceSpans.service, filter.service) : undefined,
        filter.requestId ? eq(traceSpans.requestId, filter.requestId) : undefined,
        errorTraceIds ? inArray(traceSpans.traceId, errorTraceIds) : undefined,
        gte(traceSpans.startTime, since),
      ].filter((c) => c !== undefined);
      const where = and(...conds);
      const having = filter.minDurationMs
        ? sql`having (extract(epoch from (max(${traceSpans.endTime}) - min(${traceSpans.startTime}))) * 1000) >= ${filter.minDurationMs}`
        : sql``;
      const result = await db.execute<{ count: string }>(sql`
        select count(*)::text as count from (
          select 1 from ${traceSpans} where ${where} group by ${traceSpans.traceId} ${having}
        ) t
      `);
      return Number(result.rows[0]?.count ?? 0);
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

    async channelTopology(sinceMs) {
      // last_error = 时间最晚的错误消息(B1:v1 无序聚合取到任意序;desc 序保证与 last_at 语义对齐)
      const result = await db.execute<{
        channel: string | null;
        attempts: string;
        errors: string;
        avg_ms: string | null;
        last_at: Date | string | null;
        last_error: string | null;
      }>(sql`
        select channel,
               count(*)::text as attempts,
               count(*) filter (where status_code = 2)::text as errors,
               round(avg(duration_ms))::text as avg_ms,
               max(start_time) as last_at,
               (array_agg(status_message order by start_time desc) filter (where status_code = 2))[1] as last_error
        from trace_spans
        where service = 'gateway'
          and name like 'upstream%'
          and start_time >= ${new Date(sinceMs)}
        group by channel
        order by count(*) desc
      `);
      return result.rows.map((row) => ({
        channel: row.channel ?? '(未标注)',
        attempts: Number(row.attempts),
        errors: Number(row.errors),
        avgDurationMs: Number(row.avg_ms ?? 0),
        lastAt: row.last_at ? new Date(row.last_at).getTime() : null,
        lastError: row.last_error,
      }));
    },

    async stats() {
      const countRow = await db.execute<{ total: string; oldest: Date | null }>(sql`
        select count(*)::text as total, min(start_time) as oldest from trace_spans
      `);
      const row = countRow.rows[0];
      const oldest = row?.oldest ? new Date(row.oldest) : null;
      return {
        spans: Number(row?.total ?? 0),
        oldestDays: oldest ? Math.floor((Date.now() - oldest.getTime()) / 86_400_000) : null,
        partitions: await listTracePartitionDays(db),
      };
    },
  };
}
