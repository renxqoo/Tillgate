/**
 * 生成任务 postgres 存储真实契约（*.real.test.ts；默认门禁排除，test:real 显式运行）：
 * 入队落行 + 属主隔离查询。隔离策略 = 每次运行独立 schema 应用全量迁移链
 * （DDL 单一真源 = packages/db/migrations），结束 drop cascade。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, createDb, type Db } from '@tokenlens/db';
import { createPostgresGenerationTaskStore } from '../src/adapters/generation-pg.js';
import type { GenerationTaskRecord } from '../src/ports/generation.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;

describe.skipIf(url == null)('生成任务 postgres 存储（真实 PG）', () => {
  let db: Db;
  let schema = '';
  let ownerId: number;
  let otherId: number;
  let seed: { requestId: string; mappingId: number; channelId: number; apiKeyId: number };

  beforeAll(async () => {
    schema = `tokenlens_inf_gen_${process.pid.toString(36)}_${Date.now().toString(36)}`;
    const [baseUrl] = url!.split('?');
    db = createDb({
      url: `${baseUrl}?options=-c%20search_path%3D${schema}`,
      poolMax: 5,
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 3_000,
      maxUses: 1_000,
    });
    const migrationsDir = fileURLToPath(new URL('../../db/migrations', import.meta.url));
    const { readdirSync } = await import('node:fs');
    await db.execute(sql.raw(`create schema ${schema}`));
    try {
      // 空库可推进范围 = 0000–0054（db IMPLEMENTATION §6 探针结论：0055 起依赖
      // identity-core provision 链先建 identity_session_anchors）；generation_tasks
      // 在 0053/0054 落库，FK 祖先全部 ≤0054——回放子链即覆盖本测试所需全部 DDL
      for (const file of readdirSync(migrationsDir)
        .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 54)
        .toSorted()) {
        const text = readFileSync(`${migrationsDir}/${file}`, 'utf8');
        for (const statement of text.split('--> statement-breakpoint')) {
          // 迁移 SQL 是已应用的生产事实（一字不改）；drizzle 生成的 13 条 FK 带显式
          // "public". 限定（0000×12 + 0051×1），隔离 schema 回放时剥离限定走 search_path
          const trimmed = statement.trim().replaceAll('"public".', '');
          if (trimmed) await db.execute(sql.raw(trimmed));
        }
      }
    } catch (error) {
      await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
      await closeDb(db);
      throw error;
    }

    // 最小 FK 种子链：users → providers → channels / model_mappings / api_keys / billing_requests
    const one = async (statement: ReturnType<typeof sql>) => {
      const r = await db.execute(statement);
      return r.rows[0] as Record<string, unknown>;
    };
    const owner = await one(sql`
      insert into users (issuer, subject, identity_provider) values ('it-gen', 'owner', 'oidc')
      returning id`);
    const other = await one(sql`
      insert into users (issuer, subject, identity_provider) values ('it-gen', 'other', 'oidc')
      returning id`);
    // node-postgres 裸查询的 bigint 返回字符串——显式 Number 收敛（drizzle 侧才是 number）
    ownerId = Number(owner.id);
    otherId = Number(other.id);
    const provider = await one(sql`
      insert into providers (name, base_url) values ('it-gen-provider', 'https://upstream.example')
      returning id`);
    const channel = await one(sql`
      insert into channels (provider_id, name, api_key_enc)
      values (${provider.id}, 'it-gen-channel', 'enc:v1:seed')
      returning id`);
    const mapping = await one(sql`
      insert into model_mappings (external_name, real_model) values ('it-gen-model', 'real-gen')
      returning id`);
    const apiKey = await one(sql`
      insert into api_keys (key_hash, key_preview, user_id, name)
      values ('hash-it-gen', 'preview', ${ownerId}, 'it-gen-key')
      returning id`);
    const request = await one(sql`
      insert into billing_requests (request_id, user_id, reserved_amount, quote, authorization_fingerprint)
      values (gen_random_uuid(), ${ownerId}, '0', '{}'::jsonb, 'fp-it-gen')
      returning request_id`);
    seed = {
      requestId: String(request.request_id),
      mappingId: Number(mapping.id),
      channelId: Number(channel.id),
      apiKeyId: Number(apiKey.id),
    };
  });

  afterAll(async () => {
    // 独立 schema：整体 drop 即自清（不触碰库内既有对象）
    if (schema) await db.execute(sql.raw(`drop schema if exists ${schema} cascade`));
    await closeDb(db);
  });

  const record = (
    taskId: string,
    upstreamTaskId: string | null = `up-${taskId.slice(-1)}`,
  ): GenerationTaskRecord => ({
    taskId,
    requestId: seed.requestId,
    userId: ownerId,
    apiKeyId: seed.apiKeyId,
    mappingId: seed.mappingId,
    channelId: seed.channelId,
    kind: 'video',
    upstreamTaskId,
    status: 'queued',
    params: { prompt: 'it', duration: 6 },
    receiptTemplate: {
      requestId: seed.requestId,
      userId: ownerId,
      apiKeyId: seed.apiKeyId,
      appId: null,
      credentialType: 'key',
      externalModel: 'it-gen-model',
      realModel: 'real-gen',
      channelId: seed.channelId,
      channelKey: 'it-gen-channel',
      usage: { estimated: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units: 6 },
      inputPrice: '0',
      outputPrice: '0',
      cacheInputPrice: '0',
      cacheWritePrice: '0',
      unitPrice: '0',
      coefficient: '1',
      durationMs: 5,
      stream: false,
      streamAborted: false,
      mappingId: seed.mappingId,
      billingPolicyFingerprint: null,
    },
    unitsSnapshot: 6,
    expiresAt: Date.now() + 3_600_000,
  });

  it('insert 落行 → 属主查询回读全字段', async () => {
    const store = createPostgresGenerationTaskStore(db);
    await store.insert(record('019c0b7d-0000-7000-8000-000000000001'));
    const view = await store.findByOwner(ownerId, '019c0b7d-0000-7000-8000-000000000001');
    expect(view).toMatchObject({
      taskId: '019c0b7d-0000-7000-8000-000000000001',
      kind: 'video',
      status: 'queued',
      upstreamTaskId: 'up-1',
      params: { prompt: 'it', duration: 6 },
      failReason: null,
    });
    expect(view!.result).toBeNull();
    expect(view!.createdAt).toBeGreaterThan(0);
    expect(view!.expiresAt).toBeGreaterThan(Date.now());
  });

  it('属主隔离：他人查询 = 不存在（null，不泄漏存在性）', async () => {
    const store = createPostgresGenerationTaskStore(db);
    const id = '019c0b7d-0000-7000-8000-000000000002';
    await store.insert(record(id));
    expect(await store.findByOwner(otherId, id)).toBeNull();
    expect(await store.findByOwner(ownerId, '019c0b7d-0000-7000-8000-00000000dead')).toBeNull();
  });

  it('channelId 缺失（类型外缺陷输入）显式拒绝，不落模糊约束错', async () => {
    const store = createPostgresGenerationTaskStore(db);
    const bad = { ...record('019c0b7d-0000-7000-8000-000000000003'), channelId: null };
    await expect(store.insert(bad)).rejects.toThrow(/no channel hit/);
  });

  it('adminList：kind/status 过滤 + createdAt 降序 + billingStatus 左联 + total 全量', async () => {
    const store = createPostgresGenerationTaskStore(db);
    const ids = [
      '019c0b7d-0000-7000-8000-000000000011',
      '019c0b7d-0000-7000-8000-000000000012',
      '019c0b7d-0000-7000-8000-000000000013',
    ];
    for (const id of ids) await store.insert(record(id, null));
    // 种子账单行状态 = 缺省 authorized → 左联投影非空;无账单行时 null
    const all = await store.adminList({ limit: 10, offset: 0 });
    expect(all.total).toBeGreaterThanOrEqual(3);
    const mine = all.rows.filter((r) => ids.includes(r.taskId));
    expect(mine).toHaveLength(3);
    expect(mine.every((r) => r.billingStatus === 'authorized')).toBe(true);
    expect(mine.every((r) => r.requestId === seed.requestId)).toBe(true);
    // createdAt 降序
    const created = mine.map((r) => r.createdAt);
    expect(created).toEqual(created.toSorted((a, b) => b - a));

    const video = await store.adminList({ kind: 'video', limit: 10, offset: 0 });
    expect(video.rows.every((r) => r.kind === 'video')).toBe(true);
    const running = await store.adminList({ status: 'running', limit: 10, offset: 0 });
    expect(running.rows.every((r) => r.status === 'running')).toBe(true);
    // 分页:total 恒全量
    const page = await store.adminList({ kind: 'video', limit: 1, offset: 0 });
    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(video.total);
  });

  it('settledAmounts：按账单锚关联 usage_logs 实扣金额（空集不查询）', async () => {
    const store = createPostgresGenerationTaskStore(db);
    const id = '019c0b7d-0000-7000-8000-000000000021';
    await store.insert(record(id, null));
    // 未结算（无 usage_logs 行）→ 空结果
    expect(await store.settledAmounts([])).toEqual(new Map());
    expect((await store.settledAmounts([id])).size).toBe(0);
    // 落一行已计费投影（request_id = 账单锚）→ 命中金额
    await db.execute(sql`
      insert into usage_logs (request_id, user_id, credential_type, external_model, real_model,
        input_tokens, cached_input_tokens, output_tokens, coefficient, amount, calculated_amount,
        upstream_cost, plan_amount, payg_amount, billed_by, duration_ms, status)
      values (${seed.requestId}, ${ownerId}, 'key', 'it-gen-model', 'real-gen',
        0, 0, 0, '1.000', '0.42', '0.42', '0', '0.42', '0', 'payg', 1, 0)`);
    const amounts = await store.settledAmounts([id]);
    expect(Number(amounts.get(id))).toBe(0.42);
  });
});
