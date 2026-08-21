/**
 * 安全修复回归（S1 requestId / 上游错误脱敏）：
 *   - 固定 x-request-id 连发 → 服务端各自生成新 ID（RPM ZSET member 不可被固定绕过；
 *     账单各行独立）。非 UUID 头不再打进 uuid 列。
 *   - 502 message 不含真实模型名/内部细节（对外名替换 + 截断）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { apiKeys, createDb, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createBillingDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import type { UpstreamPort } from '../pipeline/upstream-port.js';
import { sanitizeUpstreamDetail } from '../http/sanitize.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2sec-${randomUUID().slice(0, 8)}`;
const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});
const billing = createBillingDomain({ db, currency: 'CNY' });

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];

/** 上游永远失败且 message 带真实模型名（脱敏验证源） */
const leakyUpstream: UpstreamPort = {
  async chat(_candidate, request) {
    return { ok: false, error: { code: 'upstream_error', message: `upstream model ${request.realModel} at https://internal-upstream.test/v1 exploded` } };
  },
  async chatStream() { throw new Error('unused'); },
};

async function seedModel(): Promise<string> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2sec.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db
    .insert(modelMappings)
    .values({ externalName: tag(), realModel: `real-secret-${tag()}`, status: 0, inputPrice: '2', outputPrice: '6', cacheInputPrice: '1' })
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

async function newFundedKey(): Promise<{ raw: string; userId: number }> {
  const ctx: RunContext = systemContext(randomUUID());
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2sec', subject: tag(), identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount: '100', refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2sec' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

const makeApp = () =>
  createApp({
    db,
    runChat: createRunChat({
      db, billing,
      buildQuote: createBuildQuote({ db }),
      resolveChannels: createResolveChannels({ db, rng: () => 0 }),
      upstream: leakyUpstream,
      config: { reservationLimit: '1000', authorizationTtlMs: 300_000, output: { defaultMax: 4_096, exposureCap: 32_768 } },
    }),
  
      oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },});

afterAll(async () => {
  if (createdUsers.length) {
    const billRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = any($1)', [createdUsers],
    );
    const billIds = billRows.rows.map((r) => r.request_id);
    if (billIds.length) {
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [billIds]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [billIds]);
    }
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

const post = (app: ReturnType<typeof makeApp>, raw: string, model: string, headers: Record<string, string> = {}) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  });

describe('S1：requestId 服务端生成（不可被客户端固定）', () => {
  it('固定 x-request-id 连发两请求 → 服务端各生成新 ID：账单独立两行、响应头回显不同', async () => {
    const model = await seedModel();
    const { raw, userId } = await newFundedKey();
    const app = makeApp();
    const fixed = randomUUID(); // 合法 UUID 形态的固定头

    const first = await post(app, raw, model, { 'x-request-id': fixed });
    const second = await post(app, raw, model, { 'x-request-id': fixed });
    expect(first.status).toBe(502);
    expect(second.status).toBe(502);

    // 响应回显的是服务端 ID（两者不同，且都 ≠ 客户端固定值）
    const echoedFirst = first.headers.get('x-request-id');
    const echoedSecond = second.headers.get('x-request-id');
    expect(echoedFirst).toBeTruthy();
    expect(echoedFirst).not.toBe(fixed);
    expect(echoedSecond).not.toBe(fixed);
    expect(echoedFirst).not.toBe(echoedSecond);

    // 账单两行独立（若信任客户端头，第二单会撞幂等键 → 409/500 而非独立落账）
    const rows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1', [userId],
    );
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.rows.map((r) => r.request_id)).size).toBe(rows.rows.length);
  });

  it('非 UUID 的 x-request-id 不再打进 uuid 列（请求正常处理，不 500）', async () => {
    const model = await seedModel();
    const { raw } = await newFundedKey();
    const app = makeApp();
    const res = await post(app, raw, model, { 'x-request-id': 'not-a-uuid-<script>' });
    expect(res.status).toBe(502); // 走完业务（上游失败），而非 uuid 解析 500
  });
});

describe('上游错误脱敏（sanitizeUpstreamDetail）', () => {
  it('纯函数：真实模型名替换为对外名；空值兜底；超长截断', () => {
    expect(sanitizeUpstreamDetail('model real-secret-x boom', { externalModel: 'public-x', realModels: ['real-secret-x'] }))
      .toBe('model public-x boom');
    expect(sanitizeUpstreamDetail(null, { externalModel: 'public-x' })).toBe('upstream service error');
    expect(sanitizeUpstreamDetail('   ', {})).toBe('upstream service error');
    const long = 'x'.repeat(500);
    expect(sanitizeUpstreamDetail(long, { maxLength: 100 }).length).toBeLessThanOrEqual(101);
  });

  it('端到端：502 message 不含真实模型名与内部 URL，只含对外名', async () => {
    const model = await seedModel();
    const { raw } = await newFundedKey();
    const app = makeApp();
    const res = await post(app, raw, model);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).not.toContain('real-secret-');
    expect(json.error.message).not.toContain('internal-upstream.test');
    expect(json.error.message).toContain(model); // 对外名保留（用户可理解）
  });
});
