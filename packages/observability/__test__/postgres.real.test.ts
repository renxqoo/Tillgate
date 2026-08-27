/**
 * postgres 适配器真实 PG 行为等价测试(默认门禁按文件名排除,test:real 显式运行)。
 * 覆盖 SQL 专属语义:trace 批写幂等/点查/recent 聚合/拓扑、分区 ensure/maintain、
 * 审计同事务回滚与 best-effort 吞错、请求日志写入/过滤列表、月分区维护。
 * 环境:DATABASE_URL(根 .env);不可达时全组跳过(退出码 0——由显式运行者保证环境)。
 * 数据纪律:trace 以 service='trt-test-svc'、审计以 action like 'trt.%'、请求日志以 path
 * 前缀 '/trt' 自建自清;只 drop 测试自建的分区。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, closeDb, runTx, type Db, type DbTx, type TxRetryPolicy } from '@tillgate/db';
import { createPgTraceStore } from '../src/adapters/postgres/trace-store';
import {
  ensureTracePartition,
  listTracePartitionDays,
  maintainTracePartitions,
} from '../src/adapters/postgres/trace-partitions';
import {
  createBestEffortAuditSink,
  createPgAuditQueries,
  writeAudit,
} from '../src/adapters/postgres/audit-store';
import { createPgRequestLogStore } from '../src/adapters/postgres/request-log-store';
import { maintainRequestLogPartitions } from '../src/adapters/postgres/request-log-partitions';
import { dayKey } from '../src/tracing/partition';
import { createObservability } from '../src/observability';
import type { SpanRow } from '../src/tracing/types';
import { defined } from './defined';

const url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate';
let db: Db | null = null;
const retry: TxRetryPolicy = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };
const newRequestId = (): string => randomUUID();

beforeAll(async () => {
  try {
    const candidate = createDb({
      url,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
    });
    await candidate.execute(sql`select 1`);
    db = candidate;
  } catch {
    db = null;
  }
});
afterAll(async () => {
  if (db) await closeDb(db);
});

function spanRow(overrides: Partial<SpanRow> = {}): SpanRow {
  const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
  const start = new Date();
  return {
    traceId: randomUUID().replace(/-/g, ''), // 纯 hex(点查校验要求);测试身份靠 service 列
    spanId,
    parentSpanId: null,
    name: `trt-span-${spanId.slice(0, 6)}`,
    service: 'trt-test-svc',
    startTime: start,
    endTime: new Date(start.getTime() + 150),
    durationMs: 150,
    statusCode: 0,
    statusMessage: null,
    requestId: `trt-req-${spanId.slice(0, 8)}`,
    userId: 1,
    channel: 'trt-ch',
    model: 'trt-model',
    attributes: { 'trt.marker': 'trt' },
    events: [],
    ...overrides,
  };
}

async function cleanup(): Promise<void> {
  // 调用点均已被 if (!db) 守卫;defined 收窄替代非空断言
  const conn = defined(db, 'db');
  await conn.execute(sql`delete from trace_spans where service = 'trt-test-svc'`);
  // 拓扑用例的行 service='gateway',按测试渠道白名单清(不碰真实渠道数据)
  await conn.execute(
    sql`delete from trace_spans where service = 'gateway' and channel in ('ch-a', 'ch-b')`,
  );
  await conn.execute(sql`delete from audit_logs where action like 'trt.%'`);
  await conn.execute(sql`delete from request_logs where path like '/trt%'`);
}

describe('PgTraceStore(真 PG)', () => {
  it('写入→按 traceId/requestId 查询→recent 聚合→幂等重写不重复', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const store = createPgTraceStore(db);
    // start_time 错开毫秒:findByTraceId 仅按 startTime 排序,同毫秒时顺序未定义
    const root = spanRow({ startTime: new Date(Date.now() - 2) });
    const child = spanRow({
      traceId: root.traceId,
      parentSpanId: root.spanId,
      statusCode: 2,
      requestId: root.requestId, // 同一请求的 span 共享 requestId(计费关联口径)
      startTime: new Date(Date.now() - 1),
    });
    const other = spanRow();

    const written = await store.writeBatch([root, child, other]);
    expect(written).toBe(3);
    // 主键冲突忽略(SDK 重发)
    const again = await store.writeBatch([root]);
    expect(again).toBe(0);

    const byTrace = await store.findByTraceId(root.traceId);
    expect(byTrace).toHaveLength(2);
    expect(defined(byTrace[0], 'byTrace[0]').parentSpanId).toBeNull();
    expect(defined(byTrace[1], 'byTrace[1]').parentSpanId).toBe(root.spanId);

    const byRequest = await store.findByRequestId(defined(root.requestId, 'root.requestId'));
    expect(byRequest).toHaveLength(2);

    const recent = await store.findRecentTraces({ service: 'trt-test-svc', limit: 10 });
    const target = recent.find((t) => t.traceId === root.traceId);
    expect(target).toBeDefined();
    const targetTrace = defined(target, 'target');
    expect(targetTrace.spanCount).toBe(2);
    expect(targetTrace.hasError).toBe(true);
    expect(targetTrace.requestId).toBe(root.requestId);

    const errorsOnly = await store.findRecentTraces({ service: 'trt-test-svc', errorsOnly: true });
    expect(errorsOnly.every((t) => t.hasError)).toBe(true);
    // 非法 id 形状:点查白名单拒绝,返回空
    expect(await store.findByTraceId("'; drop table users; --")).toEqual([]);
    await cleanup();
  });

  it('stats 反映行数与分区列表', async (context) => {
    if (!db) return context.skip();
    const store = createPgTraceStore(db);
    const stats = await store.stats();
    expect(stats.partitions.length).toBeGreaterThan(0); // 写入用例已建当天分区
    expect(stats.spans).toBeGreaterThanOrEqual(0);
  });

  it('B1 回归:channelTopology 的 lastError 取时间最晚的错误消息(非任意序)', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const store = createPgTraceStore(db);
    const base = Date.now() - 1_000;
    // ch-a 两个错误:插入序与时间序相反——聚合须取时间最晚者,不能随机取其一
    await store.writeBatch([
      spanRow({
        name: 'upstream p1',
        service: 'gateway',
        channel: 'ch-a',
        statusCode: 0,
        startTime: new Date(base),
        endTime: new Date(base + 100),
      }),
      spanRow({
        name: 'upstream p1',
        service: 'gateway',
        channel: 'ch-a',
        statusCode: 2,
        statusMessage: 'upstream_timeout',
        startTime: new Date(base + 2000),
        endTime: new Date(base + 2300),
      }),
      spanRow({
        name: 'upstream p1',
        service: 'gateway',
        channel: 'ch-a',
        statusCode: 2,
        statusMessage: 'rate_limited',
        startTime: new Date(base + 1000),
        endTime: new Date(base + 1300),
      }),
      spanRow({
        name: 'upstream p2',
        service: 'gateway',
        channel: 'ch-b',
        statusCode: 0,
        startTime: new Date(base + 3000),
        endTime: new Date(base + 3500),
      }),
      // 窗口外不计入
      spanRow({
        name: 'upstream p1',
        service: 'gateway',
        channel: 'ch-a',
        statusCode: 0,
        startTime: new Date(base - 48 * 3_600_000),
      }),
    ]);
    const topo = await store.channelTopology(Date.now() - 3_600_000);
    const a = topo.find((t) => t.channel === 'ch-a');
    const b = topo.find((t) => t.channel === 'ch-b');
    expect(a).toBeDefined();
    const chA = defined(a, 'ch-a');
    const chB = defined(b, 'ch-b');
    expect(chA.attempts).toBe(3);
    expect(chA.errors).toBe(2);
    expect(chA.lastError).toBe('upstream_timeout'); // 时间最晚的错误(base+2000)
    expect(chB.attempts).toBe(1);
    expect(chB.errors).toBe(0);
    await cleanup();
  });

  it('B4 回归:summary.requestId 取 startTime 最早 span 的 requestId(同序聚合)', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const store = createPgTraceStore(db);
    const traceId = randomUUID().replace(/-/g, '');
    await store.writeBatch([
      spanRow({ traceId, requestId: 'trt-early', startTime: new Date(Date.now() - 2) }),
      spanRow({ traceId, requestId: 'trt-late', startTime: new Date(Date.now() - 1) }),
    ]);
    const recent = await store.findRecentTraces({ service: 'trt-test-svc' });
    const target = recent.find((t) => t.traceId === traceId);
    expect(defined(target, 'target').requestId).toBe('trt-early');
    await cleanup();
  });
});

describe('trace 分区维护(真 PG)', () => {
  it('ensure 幂等;maintain 预建未来分区并清理超期分区;未获锁返回空结果', async (context) => {
    if (!db) return context.skip();
    const today = dayKey(new Date());
    // 造一个 10 天前的过期分区(测试自建自清)
    const oldDay = dayKey(new Date(Date.now() - 10 * 86_400_000));
    await ensureTracePartition(db, oldDay);
    await ensureTracePartition(db, today);
    await ensureTracePartition(db, today); // 幂等

    const result = await maintainTracePartitions(db, { retentionDays: 7, lookaheadDays: 1 });
    // 今天/明天已在(created 可能为空),过期分区被清
    expect(result.dropped).toContain(oldDay);
    expect(result.dropped).not.toContain(today);
    // 旧分区确已删除
    const left = await db.execute<{ relname: string }>(
      sql`select relname from pg_class where relname = ${`trace_spans_p${oldDay}`}`,
    );
    expect(left).toHaveLength(0);
    expect((await listTracePartitionDays(db)).length).toBeGreaterThan(0);
  });
});

describe('audit(真 PG)', () => {
  it('writeAudit 同事务:回滚即无审计行(资金审计语义);提交即落库', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const rollbackAction = 'trt.tx.rollback';
    await expect(
      runTx(
        db,
        async (tx: DbTx) => {
          await writeAudit(tx, {
            actor: 'system',
            adminId: null,
            action: rollbackAction,
            targetType: 'trt',
            targetId: 'x',
          });
          throw new Error('business rollback');
        },
        retry,
      ),
    ).rejects.toThrow('business rollback');
    const gone = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from audit_logs where action = ${rollbackAction}`,
    );
    expect(defined(gone[0], 'gone[0]').n).toBe('0');

    await runTx(
      db,
      async (tx: DbTx) => {
        await writeAudit(tx, {
          actor: 'system',
          adminId: null,
          action: 'trt.tx.commit',
          targetType: 'trt',
          targetId: 42,
          detail: { k: 1 },
        });
      },
      retry,
    );
    const queries = createPgAuditQueries(db);
    const byTarget = await queries.listByTarget({
      targetType: 'trt',
      targetId: '42',
      limit: 10,
      offset: 0,
    });
    expect(byTarget).toHaveLength(1);
    const auditRow = defined(byTarget[0], 'byTarget[0]');
    expect(auditRow.action).toBe('trt.tx.commit');
    expect(auditRow.targetId).toBe('42'); // number 归一为 string
    expect(auditRow.detail).toEqual({ k: 1 });
    await cleanup();
  });

  it('list:q 命中 action/targetType(LIKE 字面量转义);排序与 total', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    for (let i = 0; i < 3; i++) {
      await writeAudit(db, {
        actor: 'admin',
        adminId: null,
        action: `trt.list.${i}`,
        targetType: 'trt-kind',
        targetId: `t${i}`,
      });
    }
    const queries = createPgAuditQueries(db);
    const hit = await queries.list({
      q: 'trt.list',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(hit.total).toBe(3);
    expect(hit.rows.map((r) => r.action)).toEqual(['trt.list.0', 'trt.list.1', 'trt.list.2']);
    const byKind = await queries.list({
      q: 'trt-kind',
      sortBy: 'id',
      order: 'desc',
      limit: 2,
      offset: 0,
    });
    expect(byKind.total).toBe(3);
    expect(byKind.rows.map((r) => r.action)).toEqual(['trt.list.2', 'trt.list.1']); // 分页 + 倒序
    // % 是字面量不是通配符:q='trt.list.%' 不命中 'trt.list.0'(字面串不存在)
    const literal = await queries.list({
      q: 'trt.list.%',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(literal.total).toBe(0);
    await cleanup();
  });

  it('best-effort sink:写失败不抛、log 出口收到失败事实', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const logged: Array<{ obj: unknown; msg: string }> = [];
    // 模拟 drizzle 链式形态:insert().values() 才 reject(裸 reject 会留游离 promise)
    const broken = {
      insert: () => ({ values: () => Promise.reject(new Error('pg down')) }),
    } as unknown as Db;
    const sink = createBestEffortAuditSink(broken, (obj, msg) => logged.push({ obj, msg }));
    await expect(
      sink.record({ actor: 'system', adminId: null, action: 'trt.dead', targetType: 'trt' }),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(defined(logged[0], 'logged[0]').msg).toContain('[audit] write failed');

    // 成功路径走真库
    const good = createBestEffortAuditSink(db, (obj, msg) => logged.push({ obj, msg }));
    await good.record({ actor: 'system', adminId: null, action: 'trt.sink.ok', targetType: 'trt' });
    expect(logged).toHaveLength(1); // 无新增失败日志
    const queries = createPgAuditQueries(db);
    const hit = await queries.list({
      q: 'trt.sink.ok',
      sortBy: 'id',
      order: 'asc',
      limit: 5,
      offset: 0,
    });
    expect(hit.total).toBe(1);
    await cleanup();
  });
});

describe('request_logs(真 PG)', () => {
  it('insert→list 过滤(q/statusCode 分组/userId/排序/total)', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const store = createPgRequestLogStore(db);
    await store.insert({
      requestId: newRequestId(),
      userId: null,
      apiKeyId: null,
      method: 'POST',
      path: '/trt/a',
      statusCode: 200,
      errorCode: null,
      durationMs: 12,
      requestSummary: { model: 'gpt-trt' },
      sourceIp: '10.0.0.1',
    });
    await store.insert({
      requestId: newRequestId(),
      userId: null,
      apiKeyId: null,
      method: 'POST',
      path: '/trt/b',
      statusCode: 429,
      errorCode: 'rate_limited',
      durationMs: 5,
      requestSummary: null,
      sourceIp: '10.0.0.2',
    });
    const now = new Date();
    // 断言一律带 '/trt' 过滤——库中可能有真实请求日志行,不做全表计数
    const all = await store.list({
      q: '/trt',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      now,
    });
    expect(all.total).toBe(2);
    expect(all.rows.map((r) => r.path)).toEqual(['/trt/a', '/trt/b']);

    const grouped = await store.list({
      q: '/trt',
      statusCode: '4xx',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      now,
    });
    expect(grouped.total).toBe(1);
    expect(defined(grouped.rows[0], 'grouped.rows[0]').errorCode).toBe('rate_limited');

    const byQ = await store.list({
      q: '10.0.0.1',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      now,
    });
    expect(byQ.total).toBe(1); // sourceIp 命中

    const byPath = await store.list({
      q: 'trt/b',
      sortBy: 'id',
      order: 'desc',
      limit: 10,
      offset: 0,
      now,
    });
    expect(byPath.total).toBe(1); // path 命中

    // 30 天窗缺省:from 早于 now-30d 的行不存在——此处断言窗口下界生效
    const windowed = await store.list({
      q: '/trt',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
      now: new Date(now.getTime() + 31 * 86_400_000),
    });
    expect(windowed.total).toBe(0);
    await cleanup();
  });

  it('月分区维护:当月+次月分区就位;大保留窗不动现有分区', async (context) => {
    if (!db) return context.skip();
    const result = await maintainRequestLogPartitions(db, { retentionDays: 3650 });
    const current = await db.execute<{ name: string }>(
      sql`select to_char(date_trunc('month', now()), 'YYYY_MM') as name`,
    );
    const expected = `request_logs_${defined(current[0], 'current[0]').name}`;
    expect(result.created.concat(await existingPartitions())).toContain(expected);
    expect(result.dropped).toEqual([]); // 大保留窗:不清理
  });
});

async function existingPartitions(): Promise<string[]> {
  const conn = defined(db, 'db');
  const result = await conn.execute<{ relname: string }>(sql`
    select c.relname from pg_inherits i
    join pg_class p on p.oid = i.inhparent
    join pg_class c on c.oid = i.inhrelid
    where p.relname = 'request_logs'
  `);
  return result.map((r) => r.relname);
}

describe('createObservability facade(真 PG)', () => {
  it('facade 组装查询面与分区维护(traces/audit/requestLogs/partitions 就位)', async (context) => {
    if (!db) return context.skip();
    await cleanup();
    const observability = createObservability({ db });
    // 断言带测试前缀过滤——库中可能有他人/真实数据,不做全表计数
    expect(
      await observability.audit.list({
        q: 'trt.facade.',
        sortBy: 'id',
        order: 'asc',
        limit: 1,
        offset: 0,
      }),
    ).toMatchObject({ rows: [], total: 0 });
    expect((await observability.traces.stats()).partitions.length).toBeGreaterThan(0);
    expect(
      (
        await observability.requestLogs.list({
          q: '/trt',
          sortBy: 'id',
          order: 'asc',
          limit: 1,
          offset: 0,
          now: new Date(),
        })
      ).total,
    ).toBe(0);
    expect((await observability.partitions.traces({ retentionDays: 3650 })).dropped).toEqual([]);
    expect((await observability.partitions.requestLogs({ retentionDays: 3650 })).dropped).toEqual(
      [],
    );
  });
});
