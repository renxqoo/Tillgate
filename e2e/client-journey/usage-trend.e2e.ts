/**
 * /v1/usage/trend 端点真实装配旅程（隔离 schema，不碰 public）：
 * 种子 usage_logs 三行（同小时两模型 + 前一小时聚合）→ 全真 client-api 装配 →
 * 断言 day/hour 两粒度的桶键、模型维度与聚合值；非法粒度 400。
 * 隔离 schema 复用 gateway kit 的全迁移链回放范式；infra 不可达整套 skip（装置纪律）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { createDb, closeDb, type Db } from '../../packages/db/src/index.js';
import { loadClientApiConfig } from '../../apps/client-api/src/config.js';
import { createClientApiApp } from '../../apps/client-api/src/app.js';
import { assembleClientApi } from '../../apps/client-api/src/assembly.js';

const PG_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tillgate';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../packages/db/migrations', import.meta.url));

function shortDb(): Db {
  return createDb({
    url: PG_URL,
    poolMax: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000,
  });
}

/** 前向引用容忍白名单（同 gateway kit：0055/0056/0057 目标表在 0059/0076 才建） */
const REPLAY_MISSING_RELATION_ALLOWLIST = new Set([
  '0055_session_anchors_backfill.sql',
  '0056_ledger_operations_backfill.sql',
  '0057_payment_orders_fk_ledger_operations.sql',
]);

function isMissingRelation(error: unknown, file: string): boolean {
  if (!REPLAY_MISSING_RELATION_ALLOWLIST.has(file)) return false;
  let cur: unknown = error;
  for (let depth = 0; cur != null && depth < 5; depth += 1) {
    const e = cur as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
    if (e.code === '42P01' || e.errno === '42P01') return true;
    if (typeof e.message === 'string' && /relation "[^"]+" does not exist/.test(e.message)) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/** 隔离 schema：全迁移链回放（public. 前缀重写；scoped 连接已前置 search_path） */
async function replayMigrations(target: Db, targetSchema: string): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .toSorted();
  for (const file of files) {
    const text = readFileSync(`${MIGRATIONS_DIR}/${file}`, 'utf8');
    for (const statement of text.split('--> statement-breakpoint')) {
      const rewritten = statement
        .trim()
        .replaceAll('public.', `${targetSchema}.`)
        .replaceAll('"public"', `"${targetSchema}"`);
      if (!rewritten) continue;
      try {
        await target.execute(sql.raw(rewritten));
      } catch (error) {
        // 白名单内且确为「关系不存在」才容忍（同 gateway kit 口径）——其余响亮失败
        if (!isMissingRelation(error, file)) throw error;
      }
    }
  }
}

/**
 * 今日当地第 H 小时的整点时刻（SQL 字面量——种子锚定今日桶，不随 now 回溯；
 * 00:00–01:59 运行时 H=0/1 仍落在今日桶内，消除午夜红窗）。H 超出已过小时时
 * 为未来桶（聚合语义允许——断言只锚桶键与值，不锚「已发生」）。
 */
function shHourOfDay(hour: number): string {
  return `(date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '${hour} hours') at time zone 'Asia/Shanghai'`;
}

interface World {
  db: Db;
  schema: string;
  app: ReturnType<typeof createClientApiApp>;
  token: string;
  teardown(): Promise<void>;
}

/** PG 探活（短连接） */
async function infraUp(): Promise<boolean> {
  try {
    const probe = shortDb();
    await probe.execute(sql`select 1`);
    await closeDb(probe);
    return true;
  } catch {
    return false; // infra 不可达 → 整套 skip（装置 fail-safe 纪律）
  }
}

/** 隔离 schema 建立：建 schema 用独立短连接（scoped 连接的 search_path 指向尚不存在的 schema） */
async function createIsolatedDb(schema: string): Promise<Db> {
  const creator = shortDb();
  try {
    await creator.execute(sql.raw(`create schema ${schema}`));
  } finally {
    await closeDb(creator);
  }
  // 迁移回放与种子都落在隔离 schema（search_path 前置，同 gateway kit 范式）
  return createDb({
    url: `${PG_URL}?options=-c%20search_path%3D${schema}`,
    poolMax: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000,
  });
}

/** 隔离 schema 拆除（drop cascade + 关连接；失败吞掉——拆除路径不抛） */
async function teardownDb(db: Db, schema: string): Promise<void> {
  await db.execute(sql.raw(`drop schema if exists ${schema} cascade`)).catch(() => {});
  await closeDb(db);
}

/** 装配 env（隔离连接串 + 密钥类测试值） */
function assembleEnv(schema: string): Record<string, string> {
  return {
    DATABASE_URL: `${PG_URL}?options=-c%20search_path%3D${schema}`,
    REDIS_URL,
    CLIENT_USAGE_TZ: 'Asia/Shanghai',
    JWT_SECRET: 'e2e-test-jwt-secret-0123456789abcdef',
    CLIENT_CODE_PEPPER: 'e2e-test-pepper-0123456789abcdef',
    ENCRYPTION_KEY: 'e2e-test-encryption-0123456789abcdef',
    SMTP_URL: 'smtp://localhost:25',
    FRONTEND_URL: 'http://localhost:3000',
  };
}

/** env 快照 → 覆盖（返回恢复函数；缺省恢复 = 置回空串——不动态 delete，lint 口径） */
function withEnv(overrides: Record<string, string>): () => void {
  const keys = Object.keys(overrides);
  const prev = keys.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return () => {
    for (const [k, v] of prev) {
      process.env[k] = v ?? '';
    }
  };
}

/** 种子：用户 + usage_logs 三行（当前小时前 1h/2h 两桶 × 两模型） */
async function seedTrendRows(db: Db, schema: string): Promise<void> {
  await db.execute(
    sql.raw(`
    insert into ${schema}.users (issuer, subject, identity_provider, status, created_at, updated_at)
    values ('local', 'trend-e2e', 'password', 0, now(), now())
  `),
  );
  await db.execute(
    sql.raw(`
    insert into ${schema}.usage_logs
      (request_id, user_id, app_id, api_key_id, external_model, real_model, channel_id,
       input_tokens, cached_input_tokens, output_tokens, amount, coefficient,
       billed_by, plan_amount, payg_amount, duration_ms, created_at, credential_type)
    values
      ('00000000-0000-4000-8000-000000000001', 1, null, null, 'gpt-x', 'up-1', null, 100, 20, 50, '0.10', 1, 'payg', '0', '0.10', 100, ${shHourOfDay(3)}, 'key'),
      ('00000000-0000-4000-8000-000000000002', 1, null, null, 'gpt-x', 'up-1', null, 10, 0, 5, '0.02', 1, 'payg', '0', '0.02', 100, ${shHourOfDay(4)}, 'key'),
      ('00000000-0000-4000-8000-000000000003', 1, null, null, 'claude-y', 'up-2', null, 30, 0, 10, '0.03', 1, 'payg', '0', '0.03', 100, ${shHourOfDay(4)}, 'key')
  `),
  );
}

/** 世界构造（模块顶层 await——describe.skipIf 需要同步判定 infra 可达性） */
async function buildWorld(): Promise<World | null> {
  if (!(await infraUp())) return null;
  const schema = `e2e_trend_${Date.now()}`;
  const db = await createIsolatedDb(schema);
  try {
    await replayMigrations(db, schema);
    await seedTrendRows(db, schema);
  } catch (error) {
    await teardownDb(db, schema);
    throw error;
  }

  // 全真装配（密钥类 env 用测试值补齐——会话 JWT 在旅程内自签自验）
  const restoreEnv = withEnv(assembleEnv(schema));
  try {
    const config = loadClientApiConfig(process.env);
    const assembly = await assembleClientApi(config, {});
    const app = createClientApiApp(assembly.deps);
    // 会话：真实 identity.sessions.sign（HS256 JWT，与生产同路径）
    const token = await assembly.identity.sessions.sign({ realm: 'user', subjectId: 1 });
    return {
      db,
      schema,
      app,
      token,
      async teardown() {
        restoreEnv();
        await teardownDb(db, schema);
      },
    };
  } catch (error) {
    restoreEnv();
    await teardownDb(db, schema);
    throw error;
  }
}

const world = (await buildWorld()) as World | null;
const context = describe.skipIf(world == null);

/** 上海日键（断言用——与后端 CLIENT_USAGE_TZ 同源口径） */
const shToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

afterAll(async () => {
  await world?.teardown();
});

/** 模型分桶断言：gpt-x 两小时桶、claude-y 一桶；1h 前桶两模型并存 */
function assertModelSplit(
  list: Array<{ bucket: string; model: string; inputTokens: number }>,
): void {
  const gptBuckets = list.filter((r) => r.model === 'gpt-x');
  expect(gptBuckets.length).toBe(2);
  const claudeRows = list.filter((r) => r.model === 'claude-y');
  expect(claudeRows.length).toBe(1);
  const claudeBucket = claudeRows[0]?.bucket;
  const gptSameBucket = gptBuckets.find((r) => r.bucket === claudeBucket);
  expect(gptSameBucket?.inputTokens).toBe(10);
  expect(claudeRows[0]?.inputTokens).toBe(30);
}

/** skipIf 已保证 world 非 null——测试体内经 w 消费（收窄而非非空断言） */
const w = world as World;

context('usage trend 端点（真实 SQL 装配）', () => {
  it('day 粒度：模型维度行 + 聚合 + envelope 形态', async () => {
    const res = await w.app.request('/v1/usage/trend?granularity=day', {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      granularity: string;
      list: Array<{ bucket: string; model: string; requests: number; cost: string }>;
    };
    expect(body.granularity).toBe('day');
    const gptToday = body.list.find((r) => r.model === 'gpt-x' && r.bucket === shToday);
    expect(gptToday?.requests).toBe(2);
    // numeric 全精度串（与 summary 同形）——按 Decimal 归一比较
    expect(Number(gptToday?.cost)).toBeCloseTo(0.12);
    const claude = body.list.find((r) => r.model === 'claude-y');
    expect(claude?.requests).toBe(1);
    expect(Number(claude?.cost)).toBeCloseTo(0.03);
  });

  it('hour 粒度：小时桶键形态与按模型分桶', async () => {
    const res = await w.app.request('/v1/usage/trend?granularity=hour', {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      granularity: string;
      list: Array<{ bucket: string; model: string; inputTokens: number }>;
    };
    expect(body.granularity).toBe('hour');
    // 所有桶为小时键形态
    for (const row of body.list) {
      expect(row.bucket).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/);
    }
    assertModelSplit(body.list);
  });

  it('非法粒度 400；缺省 day 回显', async () => {
    const bad = await w.app.request('/v1/usage/trend?granularity=week', {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(bad.status).toBe(400);
    const day = await w.app.request('/v1/usage/trend', {
      headers: { authorization: `Bearer ${w.token}` },
    });
    expect(((await day.json()) as { granularity: string }).granularity).toBe('day');
  });
});
