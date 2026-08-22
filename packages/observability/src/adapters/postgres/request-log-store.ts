import { and, asc, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { Db } from '@tokenlens/db';
import { requestLogs, users } from '@tokenlens/db';
import type {
  RequestLogListInput,
  RequestLogRow,
  RequestLogStore,
  RequestLogWriteInput,
} from '../../request-log/types';
import { escapeLikePattern } from './search';

/**
 * request_logs 的 PG 适配:写入(best-effort 语义由调用方兜住——观测不能反噬可用性)+
 * 运维列表(缺省 30 天窗,与保留期对齐)。
 */
export function createPgRequestLogStore(db: Db): RequestLogStore {
  return {
    /** /v1/* 请求日志(鉴权前的 401/429 也记——审计与观测,非资金事实;attempts 走列缺省 1) */
    async insert(values: RequestLogWriteInput) {
      await db.insert(requestLogs).values(values);
    },

    /** 请求日志列表:q 命中 path/errorCode/sourceIp/requestId(uuid 转文本);缺省 30 天窗 */
    async list(input: RequestLogListInput) {
      const conditions = [
        gte(requestLogs.createdAt, input.from ?? new Date(input.now.getTime() - 30 * 86_400_000)),
      ];
      if (input.to) conditions.push(lte(requestLogs.createdAt, input.to));
      if (input.userId !== undefined) conditions.push(eq(requestLogs.userId, input.userId));
      if (input.statusCode !== undefined) {
        if (typeof input.statusCode === 'number') {
          conditions.push(eq(requestLogs.statusCode, input.statusCode));
        } else {
          const [lo, hi] =
            input.statusCode === '2xx'
              ? [200, 299]
              : input.statusCode === '4xx'
                ? [400, 499]
                : [500, 599];
          conditions.push(sql`${requestLogs.statusCode} between ${lo} and ${hi}`);
        }
      }
      if (input.q) {
        const pattern = escapeLikePattern(input.q);
        conditions.push(
          or(
            ilike(requestLogs.path, pattern),
            ilike(requestLogs.errorCode, pattern),
            ilike(requestLogs.sourceIp, pattern),
            sql`${requestLogs.requestId}::text ilike ${pattern}`,
          )!,
        );
      }
      const where = and(...conditions);
      const sorts = {
        id: requestLogs.id,
        statusCode: requestLogs.statusCode,
        durationMs: requestLogs.durationMs,
        createdAt: requestLogs.createdAt,
      } as const;
      const column = sorts[input.sortBy];
      const orderBy = [input.order === 'asc' ? asc(column) : desc(column), desc(requestLogs.id)];
      const [rows, countRows] = await Promise.all([
        db
          .select({
            id: requestLogs.id,
            requestId: requestLogs.requestId,
            userId: requestLogs.userId,
            userName: sql<string | null>`coalesce(${users.displayName}, ${users.email})`,
            method: requestLogs.method,
            path: requestLogs.path,
            statusCode: requestLogs.statusCode,
            errorCode: requestLogs.errorCode,
            sourceIp: requestLogs.sourceIp,
            durationMs: requestLogs.durationMs,
            // 请求摘要(model/stream/max_tokens 截断快照)——列表「模型」列的数据源
            requestSummary: requestLogs.requestSummary,
            createdAt: requestLogs.createdAt,
          })
          .from(requestLogs)
          .leftJoin(users, eq(requestLogs.userId, users.id))
          .where(where)
          .orderBy(...orderBy)
          .limit(input.limit)
          .offset(input.offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(requestLogs)
          .where(where),
      ]);
      return { rows: rows as RequestLogRow[], total: countRows[0]?.count ?? 0 };
    },
  };
}
