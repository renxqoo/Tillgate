/**
 * 生成任务族集成测试（真实 PG + stub 任务端口）：提交两形态（video 上游任务号 /
 * music 只登记）、全败三路归还、余额不足 402、归属查询（含他人 404 / 异类 404）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { Decimal } from '@ai-gateway/domain';
import { createBillingDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import type { GenerationTaskPort } from '@ai-gateway/service';
import { createApp } from '../../app.js';
import { createBuildQuote } from '../../quote/build-quote.js';
import { createResolveChannels } from '../../routing/resolve-channels.js';
import { createSubmitGeneration } from '../submit.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2gg-${randomUUID().slice(0, 8)}`;
const billing = createBillingDomain({ db, currency: 'CNY' });
const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});

interface PortSpec {
  submit?: 'ok' | 'fail-switchable' | 'fail-fatal';
  upstreamTaskId?: string;
}
function stubTaskPort(spec: PortSpec): GenerationTaskPort {
  return {
    async submitTask() {
      if (spec.submit === 'ok') return { ok: true, upstreamTaskId: spec.upstreamTaskId ?? `up-${tag()}` };
      return { ok: false, error: { code: spec.submit === 'fail-fatal' ? 'content_policy' : 'upstream_error', message: 'submit failed' } };
    },
    async executeTask() { return { ok: false, error: { code: 'unused' } }; },
    async queryTask() { return { ok: true, status: 'running' }; },
  };
}

const submitConfig = { taskTtlMs: 3_600_000, leaseGraceMs: 30_000, reservationLimit: '1000' };

function makeApp(spec: PortSpec) {
  return createApp({
    db,
    oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
    submitGeneration: createSubmitGeneration({
      db,
      billing,
      buildQuote: createBuildQuote({ db }),
      resolveChannels: createResolveChannels({ db }),
      taskPort: stubTaskPort(spec),
      config: submitConfig,
    }),
  });
}

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

/** second 计价模型（0.5 元/s）+ 单渠道 */
async function seedVideoModel(): Promise<string> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2gg.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName: tag(), realModel: `real-${tag()}`, status: 0,
      inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
      pricingUnit: 'second', unitPrice: '0.5',
    })
    .returning({ id: modelMappings.id, externalName: modelMappings.externalName });
  createdMappings.push(mapping!.id);
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });
  return mapping!.externalName;
}

/** request 计价模型（音乐：1 元/次）+ 单渠道 */
async function seedMusicModel(): Promise<string> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2gg.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName: tag(), realModel: `real-${tag()}`, status: 0,
      inputPrice: '0', outputPrice: '0', cacheInputPrice: '0',
      pricingUnit: 'request', unitPrice: '1',
    })
    .returning({ id: modelMappings.id, externalName: modelMappings.externalName });
  createdMappings.push(mapping!.id);
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });
  return mapping!.externalName;
}

async function newFundedKey(amount = '100'): Promise<{ raw: string; userId: number }> {
  const ctx: RunContext = systemContext(randomUUID());
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2gg', subject: tag(), identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2gg' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

const post = (app: ReturnType<typeof makeApp>, path: string, raw: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

afterAll(async () => {
  // 用户维度兜底清账（覆盖 channel/api_key FK——异常路径的行未必登记进 createdRequests）
  if (createdUsers.length) {
    const billRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = any($1)', [createdUsers],
    );
    const billIds = billRows.rows.map((r) => r.request_id);
    if (billIds.length) {
      await db.$client.query('delete from generation_tasks where request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [billIds]);
    }
    await db.$client.query('delete from generation_tasks where user_id = any($1)', [createdUsers]);
  }
  if (createdRequests.length) {
    await db.$client.query('delete from generation_tasks where request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [createdRequests]);
    await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [createdRequests]);
  }
  if (createdChannels.length) {
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

/** 记账取证：该用户最新账单行 */
async function latestBilling(userId: number): Promise<{ request_id: string; status: string; receipt: Record<string, unknown> | null }> {
  const rows = await db.$client.query(
    'select request_id, status, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
  );
  return rows.rows[0];
}

describe('生成任务提交（video/music）', () => {
  it('video：上游任务号落库 + 预扣 6s×0.5=3 在途 + 201 {id, task_id, queued}', async () => {
    const model = await seedVideoModel();
    const { raw, userId } = await newFundedKey();
    const app = makeApp({ submit: 'ok', upstreamTaskId: 'up-stream-1' });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; task_id: string; status: string; object: string };
    expect(json.object).toBe('video');
    expect(json.task_id).toBe('up-stream-1');
    expect(json.status).toBe('queued');

    const row = await latestBilling(userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('in_flight'); // 起租约，结算归 worker 终态
    const task = await db.$client.query<{ status: string; units_snapshot: string; upstream_task_id: string }>(
      'select status, units_snapshot, upstream_task_id from generation_tasks where id = $1', [json.id],
    );
    expect(task.rows[0]!.status).toBe('queued');
    expect(new Decimal(task.rows[0]!.units_snapshot).eq('6')).toBe(true);
    expect(task.rows[0]!.upstream_task_id).toBe('up-stream-1');
    const accounts = await wallet.accounts(systemContext(randomUUID()), userId);
    expect(new Decimal(accounts[0]!.inFlight).eq('3')).toBe(true);
  });

  it('music：task_execute 只登记不调上游（无 task_id）+ 预扣 1 次×1 元', async () => {
    const model = await seedMusicModel();
    const { raw, userId } = await newFundedKey();
    const app = makeApp({});

    const res = await post(app, '/v1/music/generations', raw, { model, prompt: 'a song', lyrics: 'la la' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string; task_id?: string; status: string };
    expect(json.task_id).toBeUndefined();
    expect(json.status).toBe('queued');

    const row = await latestBilling(userId);
    createdRequests.push(row.request_id);
    const accounts = await wallet.accounts(systemContext(randomUUID()), userId);
    expect(new Decimal(accounts[0]!.inFlight).eq('1')).toBe(true);
  });

  it('上游全败（可换错误耗尽渠道）：502 + 账单 released + 在途归零', async () => {
    const model = await seedVideoModel();
    const { raw, userId } = await newFundedKey();
    const app = makeApp({ submit: 'fail-switchable' });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    expect(res.status).toBe(502);
    const row = await latestBilling(userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('released');
    const accounts = await wallet.accounts(systemContext(randomUUID()), userId);
    expect(new Decimal(accounts[0]!.inFlight).eq('0')).toBe(true);
  });

  it('余额不足：402 + 账单零落', async () => {
    const model = await seedVideoModel();
    const { raw, userId } = await newFundedKey('1'); // 1 元 < 预扣 3 元
    const app = makeApp({ submit: 'ok' });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    expect(res.status).toBe(402);
    const count = await db.$client.query<{ n: string }>('select count(*)::text as n from billing_requests where user_id = $1', [userId]);
    expect(count.rows[0]!.n).toBe('0');
  });

  it('非法体：duration=3（下界 4）→ 400 invalid_body', async () => {
    const model = await seedVideoModel();
    const { raw } = await newFundedKey();
    const app = makeApp({ submit: 'ok' });
    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 3 });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('invalid_body');
  });
});

describe('提交编排失败分支', () => {
  it('任务行落库失败 → 503 且预留保留（租约到期由 recover 释放——禁止误退款）', async () => {
    const model = await seedVideoModel();
    const { raw, userId } = await newFundedKey();
    const { createRepositories } = await import('@ai-gateway/repository');
    const failingRepos = createRepositories();
    (failingRepos.generationTask as { insert: unknown }).insert = async () => {
      throw new Error('db down');
    };
    const app = createApp({
      db,
      oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
      submitGeneration: createSubmitGeneration({
        db, billing,
        buildQuote: createBuildQuote({ db }),
        resolveChannels: createResolveChannels({ db }),
        taskPort: stubTaskPort({ submit: 'ok' }),
        config: submitConfig,
        repos: failingRepos,
      }),
    });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('billing_receipt_unavailable');
    const row = await latestBilling(userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('in_flight'); // 预留保留，不自动退款
  });

  it('死凭据提交错误 → 渠道落库 status=4（markDeadCredential）后全败 502', async () => {
    const model = await seedVideoModel();
    const { raw } = await newFundedKey();
    const deadPort: GenerationTaskPort = {
      async submitTask() { return { ok: false, error: { code: 'invalid_api_key', message: 'dead', deadCredential: true } }; },
      async executeTask() { return { ok: false, error: { code: 'unused' } }; },
      async queryTask() { return { ok: true, status: 'running' }; },
    };
    const app = createApp({
      db,
      oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
      submitGeneration: createSubmitGeneration({
        db, billing,
        buildQuote: createBuildQuote({ db }),
        resolveChannels: createResolveChannels({ db }),
        taskPort: deadPort,
        config: submitConfig,
      }),
    });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    expect(res.status).toBe(502);
    const channel = await db.$client.query<{ status: number }>('select status from channels where id = any($1) order by id desc limit 1', [createdChannels]);
    expect(channel.rows[0]!.status).toBe(4); // 死凭据落库
  });
});

describe('生成任务查询', () => {
  it('归属者 200（queued 形状 video_url null）；他人 404；异类 404', async () => {
    const model = await seedVideoModel();
    const { raw, userId } = await newFundedKey();
    const other = await newFundedKey();
    const app = makeApp({ submit: 'ok', upstreamTaskId: 'up-q' });

    const res = await post(app, '/v1/video/generations', raw, { model, prompt: 'a cat', duration: 6 });
    const { id } = (await res.json()) as { id: string };
    const row = await latestBilling(userId);
    createdRequests.push(row.request_id);

    const mine = await app.request(`/v1/videos/${id}`, { headers: { authorization: `Bearer ${raw}` } });
    expect(mine.status).toBe(200);
    const json = (await mine.json()) as { status: string; video_url: string | null; fail_reason: string | null };
    expect(json.status).toBe('queued');
    expect(json.video_url).toBeNull();

    const stranger = await app.request(`/v1/videos/${id}`, { headers: { authorization: `Bearer ${other.raw}` } });
    expect(stranger.status).toBe(404);

    const wrongKind = await app.request(`/v1/musics/${id}`, { headers: { authorization: `Bearer ${raw}` } });
    expect(wrongKind.status).toBe(404);
  });
});
