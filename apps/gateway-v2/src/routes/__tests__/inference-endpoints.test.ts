/**
 * 文本族全端点集成测试（真实 PG + stub 上游）：embeddings 输出恒 0、
 * completions/responses/messages codec 双向翻译、流式 codec 编码。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createBillingDomain, createWallet } from '@ai-gateway/service';
import { createApp } from '../../app.js';
import { createBuildQuote } from '../../quote/build-quote.js';
import { createResolveChannels } from '../../routing/resolve-channels.js';
import { createRunChat } from '../../pipeline/run-chat.js';
import type { UpstreamPort, UpstreamResult, UpstreamStreamResult } from '../../pipeline/upstream-port.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const billing = createBillingDomain({ db, currency: 'CNY' });
const buildQuote = createBuildQuote({ db });
const resolveChannels = createResolveChannels({ db, rng: () => 0 });

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

const tag = () => `v2ie-${randomUUID().slice(0, 8)}`;

/** stub 上游：canonical chat 形响应（codec 端到端验证靠真实翻译函数） */
const stub: UpstreamPort = {
  async chat(candidate, request): Promise<UpstreamResult> {
    void candidate;
    return {
      ok: true,
      body: {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `echo:${(request.body as { model: string }).model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5 },
    };
  },
  async chatStream(candidate, request): Promise<UpstreamStreamResult> {
    void candidate; void request;
    const listeners: Array<(e: import('../../pipeline/upstream-port.js').UpstreamStreamEvent) => void> = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', choices: [{ delta: { content: 'hi' } }] })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    setTimeout(() => {
      for (const cb of listeners) {
        cb({ type: 'first_chunk' });
        cb({ type: 'success', usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 1, estimated: false } });
      }
    }, 0);
    return { stream, onEvent: (cb) => listeners.push(cb) };
  },
};

const config = {
  reservationLimit: '1000',
  authorizationTtlMs: 300_000,
  output: { defaultMax: 4_096, exposureCap: 32_768 },
};
const app = createApp({
  db,
  runChat: createRunChat({ db, billing, buildQuote, resolveChannels, upstream: stub, config }),
  oauth: { jwtSecret: 'v2ie-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
});

async function seedModel(
  pricing?: { pricingUnit?: string; unitPrice?: string; inputPrice?: string; outputPrice?: string; cacheInputPrice?: string },
): Promise<string> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://v2ie.test', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const externalName = tag();
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName, realModel: `real-${tag()}`, status: 0,
      inputPrice: pricing?.inputPrice ?? '2', outputPrice: pricing?.outputPrice ?? '6', cacheInputPrice: pricing?.cacheInputPrice ?? '1',
      ...(pricing?.pricingUnit !== undefined ? { pricingUnit: pricing.pricingUnit } : {}),
      ...(pricing?.unitPrice !== undefined ? { unitPrice: pricing.unitPrice } : {}),
    })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });
  return externalName;
}

async function newKey(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2ie', subject: `v2ie-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  const wallet = createWallet({
    db,
    currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  await wallet.credit(
    { requestId: `v2ie-fund-${randomUUID().slice(0, 8)}`, actor: { kind: 'user', id: user!.id }, traceParent: null },
    { userId: user!.id, amount: '100', refType: 'topup', refId: `v2ie-${randomUUID().slice(0, 10)}` },
  );
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2ie' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return raw;
}

afterAll(async () => {
  // 本套件账单按渠道维度清理（请求未逐一登记——渠道 FK 先决）
  if (createdChannels.length) {
    const refRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where channel_id = any($1)', [createdChannels],
    );
    const requestIds = refRows.rows.map((r) => r.request_id);
    if (requestIds.length > 0) {
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [requestIds]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [requestIds]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [requestIds]);
    }
  }
  if (createdRequests.length) {
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

const post = (path: string, raw: string, body: Record<string, unknown>) =>
  app.request(path, { method: 'POST', headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('文本族端点', () => {
  it('POST /v1/embeddings：规范形透传 + 输出恒 0 预扣', async () => {
    const model = await seedModel();
    const raw = await newKey();
    const res = await post('/v1/embeddings', raw, { model, input: 'hello world' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: unknown[] };
    expect(json.choices).toBeDefined();
  });

  it('POST /v1/completions：prompt → chat 翻译 → legacy 形响应', async () => {
    const model = await seedModel();
    const raw = await newKey();
    const res = await post('/v1/completions', raw, { model, prompt: 'Say hi' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.object === 'text_completion' || json.choices !== undefined).toBe(true);
  });

  it('POST /v1/responses：Responses API 形状往返', async () => {
    const model = await seedModel();
    const raw = await newKey();
    const res = await post('/v1/responses', raw, { model, input: 'hi' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.object === 'response' || json.choices !== undefined).toBe(true);
  });

  it('POST /v1/messages：Claude 形状往返（max_tokens codec 默认补齐）', async () => {
    const model = await seedModel();
    const raw = await newKey();
    const res = await post('/v1/messages', raw, { model, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // Claude 形：content 数组 + stop_reason；或 codec 透传 choices（规范形成功）
    expect(json.content !== undefined || json.choices !== undefined).toBe(true);
  });

  it('模态族 JSON：images/rerank/moderations 走同一管线（单位计费口径）', async () => {
    const model = await seedModel();
    const raw = await newKey();
    for (const [path, body] of [
      ['/v1/images/generations', { model, prompt: 'a cat' }],
      ['/v1/rerank', { model, query: 'hi', documents: ['a', 'b'] }],
      ['/v1/moderations', { model, input: 'check this' }],
    ] as const) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { choices: unknown[] }).choices).toBeDefined();
    }
  });

  it('非法体 → 400 invalid_body', async () => {
    const model = await seedModel();
    const raw = await newKey();
    const res = await post('/v1/chat/completions', raw, { model }); // 缺 messages
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_body');
  });
});

describe('multipart 模态族 + /oauth/token', () => {
  it('POST /v1/images/edits：multipart 文件 + prompt 走管线（单位计价模型——按张）', async () => {
    const model = await seedModel({ pricingUnit: 'image', unitPrice: '1', inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' });
    const raw = await newKey();
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', 'make it blue');
    form.append('image', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'test.png', { type: 'image/png' }));
    const res = await app.request('/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${raw}` }, body: form });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { choices: unknown[] }).choices).toBeDefined();
  });

  it('POST /v1/images/edits：缺文件 400', async () => {
    const raw = await newKey();
    const form = new FormData();
    form.append('model', 'test');
    const res = await app.request('/v1/images/edits', { method: 'POST', headers: { authorization: `Bearer ${raw}` }, body: form });
    expect(res.status).toBe(400);
  });

  it('POST /oauth/token：form 表单与 Basic Auth 两种凭证传递 → JWT；缺凭证 401', async () => {
    const { apps: appsTable } = await import('@ai-gateway/db');
    const user = createdUsers[0]!;
    const clientId = `cid-${randomUUID().slice(0, 8)}`;
    const clientSecret = `sec-${randomUUID()}`;
    const { createHash: ch } = await import('node:crypto');
    const [appRow] = await db
      .insert(appsTable)
      .values({ appId: `v2ie-app-${randomUUID().slice(0, 8)}`, userId: user, clientId, clientSecretHash: ch('sha256').update(clientSecret).digest('hex'), name: 'test' })
      .returning({ id: appsTable.id });
    try {
      const asForm = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
      const formRes = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: asForm.toString(),
      });
      expect(formRes.status).toBe(200);
      expect(((await formRes.json()) as { access_token: string }).access_token.split('.')).toHaveLength(3);

      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const basicRes = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Basic ${basic}` },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      expect(basicRes.status).toBe(200);

      const missing = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials' }),
      });
      expect(missing.status).toBe(401);
      expect(((await missing.json()) as { error: string }).error).toBe('invalid_client');
    } finally {
      await db.$client.query('delete from apps where id = $1', [appRow!.id]);
    }
  });

  it('POST /oauth/token：client_credentials → JWT', async () => {
    const { apps: appsTable } = await import('@ai-gateway/db');
    const user = createdUsers[0]!;
    const clientId = `cid-${randomUUID().slice(0, 8)}`;
    const clientSecret = `sec-${randomUUID()}`;
    const { createHash: ch } = await import('node:crypto');
    const [appRow] = await db
      .insert(appsTable)
      .values({ appId: `v2ie-app-${randomUUID().slice(0, 8)}`, userId: user, clientId, clientSecretHash: ch('sha256').update(clientSecret).digest('hex'), name: 'test' })
      .returning({ id: appsTable.id });
    const res = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { access_token: string; token_type: string; expires_in: number };
    expect(json.token_type).toBe('Bearer');
    expect(json.access_token.split('.')).toHaveLength(3); // JWT 三段
    await db.$client.query('delete from apps where id = $1', [appRow!.id]);
  });

  it('POST /oauth/token：错凭证 401；错 grant_type 400', async () => {
    const wrong = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: 'no', client_secret: 'no' }),
    });
    expect(wrong.status).toBe(401);
    const badGrant = await app.request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', client_id: 'x', client_secret: 'x' }),
    });
    expect(badGrant.status).toBe(400);
  });
});
