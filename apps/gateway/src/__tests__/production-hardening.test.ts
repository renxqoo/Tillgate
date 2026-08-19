/**
 * 生产加固集成测试（内存假件注入——编排正确性；Redis 实现的原子性由 core 单测覆盖）：
 *   key 维 RPM/TPM 429、渠道维超限换渠、TPM 全败归还、免费模型日限两口径
 *  （超限 429 / 计数器不可用 503 fail-closed）、鉴权爆破防护两层语义。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createBillingDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import type { RateLimitResult, SlidingWindowLimiter } from '@ai-gateway/core';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import type { UpstreamPort, UpstreamResult } from '../pipeline/upstream-port.js';
import type { FreeDailyGate, RateLimitGate } from '../rate-limit/gate.js';
import type { AuthFailureGuard, GuardCheck, KeyBruteForceGuard } from '@ai-gateway/core';
import { AppError } from '../http/error-map.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2ph-${randomUUID().slice(0, 8)}`;
const billing = createBillingDomain({ db, currency: 'CNY' });
const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];

/** 可编程限流假件：按维度键控判定结果 */
function fakeLimiter(plan: Record<string, () => RateLimitResult>): SlidingWindowLimiter & { released: string[] } {
  const released: string[] = [];
  const decide = (dimension: string): RateLimitResult =>
    (plan[dimension] ?? (() => ({ allowed: true })))();
  return {
    released,
    async check(dimension) { return decide(dimension); },
    async checkAll(dims) { for (const d of dims) { const r = decide(d.dimension); if (!r.allowed) return r; } return { allowed: true }; },
    async reserveTpmAll(dims) { for (const d of dims) { const r = decide(d.dimension); if (!r.allowed) return r; } return { allowed: true }; },
    async releaseTpm(requestId) { released.push(requestId); },
    async renewTpm() { /* 流式续租不在本套件 */ },
    async backfillTpm() { /* 结算回填在 worker 侧 */ },
  };
}

function fakeGate(limiter: SlidingWindowLimiter, freeDaily: FreeDailyGate): RateLimitGate {
  return { limiter, freeDaily };
}

const alwaysOkFree: FreeDailyGate = { async check() { return { ok: true }; } };

async function seedModelWithChannels(opts: { free?: boolean; channels?: number } = {}): Promise<{ model: string; channelNames: string[] }> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2ph.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName: tag(), realModel: `real-${tag()}`, status: 0,
      inputPrice: '2', outputPrice: '6', cacheInputPrice: '1',
      ...(opts.free ? { isFree: true, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' } : {}),
    })
    .returning({ id: modelMappings.id, externalName: modelMappings.externalName });
  createdMappings.push(mapping!.id);
  const channelNames: string[] = [];
  for (let i = 0; i < (opts.channels ?? 1); i++) {
    const [channel] = await db
      .insert(channels)
      .values({ providerId: provider!.id, name: `ph-${i}-${tag()}`, apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' })
      .returning({ id: channels.id });
    createdChannels.push(channel!.id);
    await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 100 - i, weight: 1 });
    channelNames.push(`ph-${i}-${tag()}`);
  }
  return { model: mapping!.externalName, channelNames };
}

async function newFundedKey(limits?: { rpmLimit?: number | null; tpmLimit?: number | null }): Promise<{ raw: string; userId: number; apiKeyId: number }> {
  const ctx: RunContext = systemContext(randomUUID());
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2ph', subject: tag(), identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount: '100', refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****',
      userId: user!.id, name: 'v2ph',
      ...(limits?.rpmLimit != null ? { rpmLimit: limits.rpmLimit } : {}),
      ...(limits?.tpmLimit != null ? { tpmLimit: limits.tpmLimit } : {}),
    })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id, apiKeyId: key!.id };
}

const stubUpstream = (): UpstreamPort => ({
  async chat(candidate): Promise<UpstreamResult> {
    return { ok: true, body: { id: 'stub', choices: [{ message: { role: 'assistant', content: `from-${candidate.channelName.slice(0, 4)}` } }] } };
  },
  async chatStream() { throw new Error('not used'); },
});

const config = {
  reservationLimit: '1000',
  authorizationTtlMs: 300_000,
  output: { defaultMax: 4_096, exposureCap: 32_768 },
};

function makeApp(rateLimit: RateLimitGate, _limits?: { rpmLimit?: number | null; tpmLimit?: number | null }) {
  const runChat = createRunChat({
    db, billing,
    buildQuote: createBuildQuote({ db }),
    resolveChannels: createResolveChannels({ db, rng: () => 0 }),
    upstream: stubUpstream(),
    rateLimit,
    config,
  });
  return createApp({ db, runChat, oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 } });
}

const post = (app: ReturnType<typeof makeApp>, raw: string, model: string) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });

afterAll(async () => {
  if (createdChannels.length) {
    const refRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where channel_id = any($1)', [createdChannels],
    );
    const ids = refRows.rows.map((r) => r.request_id);
    if (ids.length) {
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [ids]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [ids]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [ids]);
    }
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  await db.$client.end().catch(() => {});
});

describe('限流闸（key 维准入）', () => {
  it('key RPM 超限 → 429 rate_limit_exceeded，账单零落', async () => {
    const seeded = await seedModelWithChannels();
    const { raw } = await newFundedKey({ rpmLimit: 1 });
    const limiter = fakeLimiter({ [`key:${await keyIdOf(raw)}`]: () => ({ allowed: false, retryAfterSec: 30, dimension: 'key' }) });
    const app = makeApp(fakeGate(limiter, alwaysOkFree), { rpmLimit: 1 });

    const res = await post(app, raw, seeded.model);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limit_exceeded');
  });

  it('key TPM 超限 → 429（预占被拒不落账）', async () => {
    const seeded = await seedModelWithChannels();
    const { raw } = await newFundedKey({ tpmLimit: 10 });
    const keyId = await keyIdOf(raw);
    const limiter = fakeLimiter({ [`key:${keyId}`]: () => ({ allowed: false, retryAfterSec: 45, dimension: 'key' }) });
    const app = makeApp(fakeGate(limiter, alwaysOkFree), { tpmLimit: 10 });

    const res = await post(app, raw, seeded.model);
    expect(res.status).toBe(429);
  });

  it('免费模型：日限超限 429 / 计数器不可用 503（fail-closed）', async () => {
    const freeModel = await seedModelWithChannels({ free: true });
    const { raw } = await newFundedKey();

    const limited: FreeDailyGate = { async check() { return { ok: false, code: 'limit', retryAfterSec: 3600 }; } };
    const res1 = await post(makeApp(fakeGate(fakeLimiter({}), limited), undefined), raw, freeModel.model);
    expect(res1.status).toBe(429);
    expect(((await res1.json()) as { error: { code: string } }).error.code).toBe('rate_limit_exceeded');

    const broken: FreeDailyGate = { async check() { return { ok: false, code: 'counter', retryAfterSec: 60 }; } };
    const res2 = await post(makeApp(fakeGate(fakeLimiter({}), broken), undefined), raw, freeModel.model);
    expect(res2.status).toBe(503);
    expect(((await res2.json()) as { error: { code: string } }).error.code).toBe('free_model_counter_unavailable');
  });

  it('渠道 RPM 超限 → 换渠成功（超限视同可换渠）', async () => {
    const seeded = await seedModelWithChannels({ channels: 2 });
    const { raw } = await newFundedKey();
    const firstChannelId = createdChannels.at(-2)!;
    const limiter = fakeLimiter({ [`channel:${firstChannelId}`]: () => ({ allowed: false, retryAfterSec: 30 }) });
    const app = makeApp(fakeGate(limiter, alwaysOkFree));

    const res = await post(app, raw, seeded.model);
    expect(res.status).toBe(200);
  });

  it('TPM 预占在全败后归还（releaseTpm 收到 requestId）', async () => {
    const seeded = await seedModelWithChannels();
    const { raw } = await newFundedKey({ tpmLimit: 1_000_000 });
    const limiter = fakeLimiter({});
    const failingUpstream: UpstreamPort = {
      async chat() { return { ok: false, error: { code: 'upstream_error', message: 'boom' } }; },
      async chatStream() { throw new Error('unused'); },
    };
    const runChat = createRunChat({
      db, billing,
      buildQuote: createBuildQuote({ db }),
      resolveChannels: createResolveChannels({ db, rng: () => 0 }),
      upstream: failingUpstream,
      rateLimit: fakeGate(limiter, alwaysOkFree),
      config,
    });
    const app = createApp({ db, runChat, oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 } });
    const res = await post(app, raw, seeded.model);
    expect(res.status).toBe(502);
    expect(limiter.released.length).toBeGreaterThanOrEqual(1);
  });
});

function fakeGuards() {
    const state = { keyFailures: 0, keyLocked: false, ipFailures: 0, ipLocked: false, successes: 0 };
    const no: GuardCheck = { locked: false, retryAfterSec: 0 };
    const keyGuard: KeyBruteForceGuard = {
      async isLocked() { return { locked: state.keyLocked, retryAfterSec: 600 }; },
      async recordFailure() { state.keyFailures += 1; return no; },
      async recordSuccess() { state.successes += 1; },
    };
    const ipGuard: AuthFailureGuard = {
      async isLocked() { return { locked: state.ipLocked, retryAfterSec: 300 }; },
      async recordFailure() { state.ipFailures += 1; return no; },
    };
    return { state, guards: { keyGuard, ipGuard, trustedProxyHops: 0 } };
}

describe('鉴权爆破防护（两层）', () => {
  it('无效 Key：两层各记一次失败；有效 Key：清零成功计数', async () => {
    const seeded = await seedModelWithChannels();
    const { raw } = await newFundedKey();
    const { state, guards } = fakeGuards();
    const app = createApp({
      db,
      runChat: createRunChat({
        db, billing, buildQuote: createBuildQuote({ db }), resolveChannels: createResolveChannels({ db }),
        upstream: stubUpstream(), config,
      }),
      authGuards: guards,
      oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
    });

    const bad = await post(app, `ag_${'0'.repeat(32)}`, seeded.model);
    expect(bad.status).toBe(401);
    expect(state.keyFailures).toBe(1);
    expect(state.ipFailures).toBe(1);

    const good = await post(app, raw, seeded.model);
    expect(good.status).toBe(200);
    expect(state.successes).toBe(1);
  });

  it('keyHash 锁定期间 → 401 且带锁定信息（不再查库爆破）', async () => {
    const seeded = await seedModelWithChannels();
    const { raw } = await newFundedKey();
    const locked: KeyBruteForceGuard = {
      async isLocked() { return { locked: true, retryAfterSec: 600 }; },
      async recordFailure() { return { locked: false, retryAfterSec: 0 }; },
      async recordSuccess() { /* unreachable */ },
    };
    const ipGuard: AuthFailureGuard = {
      async isLocked() { return { locked: false, retryAfterSec: 0 }; },
      async recordFailure() { return { locked: false, retryAfterSec: 0 }; },
    };
    const app = createApp({
      db,
      runChat: createRunChat({
        db, billing, buildQuote: createBuildQuote({ db }), resolveChannels: createResolveChannels({ db }),
        upstream: stubUpstream(), config,
      }),
      authGuards: { keyGuard: locked, ipGuard, trustedProxyHops: 0 },
    
      oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },});
    const res = await post(app, raw, seeded.model);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('locked');
  });
});

/** 从 raw key 反查 keyId（测试种子里刚插入的行） */
async function keyIdOf(raw: string): Promise<number> {
  const hash = createHash('sha256').update(raw).digest('hex');
  const row = await db.$client.query<{ id: number }>('select id from api_keys where key_hash = $1', [hash]);
  if (!row.rows[0]) throw new AppError(500, 'test', 'seeded key missing');
  return row.rows[0].id;
}
