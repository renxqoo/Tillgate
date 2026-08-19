/**
 * v1 对位端点测试（2026-08-19 退役审计补齐）：
 *   ① /livez（nginx/LB 存活探针路径——删 v1 前必须存在）
 *   ② /v1/engines/:model/embeddings（OpenAI pre-1.0 SDK legacy 别名）
 *   ③ SSE 流式响应带 x-request-id（客户端对账锚）
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users, apiKeys, providers, modelMappings, channels, modelChannels } from '@ai-gateway/db';
import { encrypt } from '@ai-gateway/core';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBillingDomain } from '@ai-gateway/service';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import { createUpstreamAdapter } from '../pipeline/upstream-adapter.js';
import { createAi } from '@ai-gateway/ai';
import { createMemoryAiStorages } from '../pipeline/ai-storages.js';

const encryptionKey = 'parity-key-0123456789abcdef';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2p-${randomUUID().slice(0, 8)}`;

// mock 上游：非流式 usage 应答
let server: Server;
let upstreamBase = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      void raw;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-parity',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  upstreamBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdProviders: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdRequests: string[] = [];

afterAll(async () => {
  await new Promise<void>((resolve) => server.closeAllConnections?.() ?? resolve());
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of createdRequests) {
    await db.$client.query('delete from billing_reservations where billing_request_id = $1', [id]).catch(() => {});
    await db.$client.query('delete from usage_logs where request_id = $1', [id]).catch(() => {});
    await db.$client.query('delete from billing_requests where request_id = $1', [id]).catch(() => {});
  }
  // 用户维度兜底（服务端生成的 requestId 未入 createdRequests——引用 api_keys 的 FK 先清）
  if (createdUsers.length) {
    const billRows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = any($1)', [createdUsers],
    );
    const ids = billRows.rows.map((r) => r.request_id);
    if (ids.length) {
      await db.$client.query('delete from billing_reservations where billing_request_id = any($1::uuid[])', [ids]);
      await db.$client.query('delete from usage_logs where request_id = any($1::uuid[])', [ids]);
      await db.$client.query('delete from billing_requests where request_id = any($1::uuid[])', [ids]);
    }
  }
  if (createdKeys.length) await db.$client.query('delete from api_keys where id = any($1)', [createdKeys]);
  if (createdUsers.length) await db.$client.query('delete from users where id = any($1)', [createdUsers]);
  if (createdChannels.length) {
    await db.$client.query('delete from model_channels where channel_id = any($1)', [createdChannels]);
    await db.$client.query('delete from channels where id = any($1)', [createdChannels]);
  }
  if (createdMappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [createdMappings]);
  if (createdProviders.length) await db.$client.query('delete from providers where id = any($1)', [createdProviders]);
  await db.$client.end().catch(() => {});
});

async function seedAndBuild() {
  const [user] = await db.insert(users).values({ issuer: 'v2p', subject: tag(), identityProvider: 'local' }).returning({ id: users.id });
  createdUsers.push(user!.id);
  const wallet = createWallet({
    db, currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  const creditCtx: RunContext = systemContext(randomUUID());
  await wallet.credit(creditCtx, { userId: user!.id, amount: '100', refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db.insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2p' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);

  const [provider] = await db.insert(providers)
    .values({ name: tag(), baseUrl: upstreamBase, protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const externalName = tag();
  const [mapping] = await db.insert(modelMappings)
    .values({ externalName, realModel: `real-${tag()}`, status: 0, inputPrice: '2', outputPrice: '6', cacheInputPrice: '1' })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const [channel] = await db.insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: encrypt('sk-parity', encryptionKey), status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });

  const ai = createAi({ allowLocalUrl: true }, { ...createMemoryAiStorages() });
  const billing = createBillingDomain({ db, currency: 'CNY' });
  const runChat = createRunChat({
    db,
    billing,
    buildQuote: createBuildQuote({ db }),
    resolveChannels: createResolveChannels({ db }),
    upstream: createUpstreamAdapter({ ai, encryptionKey, deadlineMs: 5_000 }),
    config: { reservationLimit: '1000', authorizationTtlMs: 300_000, output: { defaultMax: 4_096, exposureCap: 32_768 } },
  });
  const app = createApp({ db, runChat, oauth: { jwtSecret: 'parity-test-secret-0123456789ab', tokenTtlSeconds: 3_600 } });
  return { app, raw, userId: user!.id, externalName, requestIdSink: createdRequests };
}

describe('v1 对位端点', () => {
  it('① GET /livez → 200（LB 探针路径）', async () => {
    const { app } = await seedAndBuild();
    const res = await app.request('/livez');
    expect(res.status).toBe(200);
  });

  it('② POST /v1/engines/:model/embeddings → 与 /v1/embeddings 同管线（legacy SDK 别名）', async () => {
    const { app, raw, externalName } = await seedAndBuild();
    const res = await app.request(`/v1/engines/${externalName}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'hello parity' }),
    });
    expect(res.status).toBe(200);
  });

  it('③ 流式响应带 x-request-id 头（客户端对账锚——raw Response 不走 c.header 合并）', async () => {
    const { app, raw, externalName } = await seedAndBuild();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: externalName, stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const requestId = res.headers.get('x-request-id');
    expect(typeof requestId).toBe('string');
    expect(requestId!.length).toBeGreaterThan(10);
    await res.text();
  }, 30_000);
});

describe('v1 对位 · models 协议形状 + v1beta 入口', () => {
  it('④ anthropic-version 头 → Anthropic 列表形；x-goog-api-key → Gemini 形', async () => {
    const { app, raw } = await seedAndBuild();
    const anthropic = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${raw}`, 'anthropic-version': '2023-06-01' },
    });
    expect(anthropic.status).toBe(200);
    const aBody = (await anthropic.json()) as { data: { id: string; display_name: string }[] };
    expect(aBody.data[0]).toHaveProperty('display_name');

    const gemini = await app.request('/v1/models', {
      headers: { authorization: `Bearer ${raw}`, 'x-goog-api-key': 'any' },
    });
    const gBody = (await gemini.json()) as { models: { name: string; supportedGenerationMethods: string[] }[] };
    expect(gBody.models[0]!.name.startsWith('models/')).toBe(true);
    expect(gBody.models[0]!.supportedGenerationMethods).toContain('generateContent');
  });

  it('⑤ POST /v1beta/models/:model:generateContent → Gemini 请求转规范形走计费管线', async () => {
    const { app, raw, externalName } = await seedAndBuild();
    const res = await app.request(`/v1beta/models/${externalName}:generateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates?: unknown };
    expect(Array.isArray(body.candidates)).toBe(true); // Gemini 原生响应形
  });

  it('⑥ :streamGenerateContent → SSE（Gemini 线格式）', async () => {
    const { app, raw, externalName } = await seedAndBuild();
    const res = await app.request(`/v1beta/models/${externalName}:streamGenerateContent`, {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await res.text();
  }, 30_000);
});
