/**
 * 生产上游链路冒烟（本地 mock HTTP 上游 + 真 createAi + 真 upstream-adapter）：
 * 验证「网关管线 ↔ 真适配器」端到端——解密、Bearer 注入、协议解析、
 * usage 归一（非流式）/ SSE 透传 + 尾帧 usage（流式可信收据）。
 * 协议矩阵（七协议各自的解析）在 ai 包套件；本套件只钉 openai-compatible 主链。
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, modelChannels, modelMappings, channels, providers, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { encrypt } from '@ai-gateway/core';
import { createAi } from '@ai-gateway/ai';
import { createBillingDomain, createWallet, systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import { createUpstreamAdapter } from '../pipeline/upstream-adapter.js';
import { createMemoryAiStorages } from '../pipeline/ai-storages.js';

const encryptionKey = 'smoke-key-0123456789abcdef';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2sm-${randomUUID().slice(0, 8)}`;
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
const createdRequests: string[] = [];

let server: Server;
let upstreamBaseUrl = '';

/** openai-compatible mock 上游：Bearer 校验 + JSON/SSE 两形态 + usage 归一源 */
beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Bearer sk-smoke-real') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    if (req.method !== 'POST' || !req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as { stream?: boolean };
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-smoke',
        choices: [{ message: { role: 'assistant', content: 'hello from mock' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  upstreamBaseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 渠道维度清账（released 行也带 channel_id FK——先决 billing 再删渠道）
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
  }
  // 用户维度兜底清账（覆盖 channel/api_key FK——异常路径的行未必登记进 createdRequests）
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
    await db.$client.query('delete from generation_tasks where user_id = any($1)', [createdUsers]);
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

/** 全真装配（与 assembly.ts 同构：真 ai + 真适配器；仅省 config/env 解析） */
async function seedAndAssemble(): Promise<{ app: ReturnType<typeof createApp>; raw: string; userId: number }> {
  const [user] = await db.insert(users).values({ issuer: 'v2sm', subject: tag(), identityProvider: 'local' }).returning({ id: users.id });
  createdUsers.push(user!.id);
  const creditCtx: RunContext = systemContext(randomUUID());
  await wallet.credit(creditCtx, { userId: user!.id, amount: '100', refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db.insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2sm' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);

  const [provider] = await db.insert(providers)
    .values({ name: tag(), baseUrl: upstreamBaseUrl, protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const [mapping] = await db.insert(modelMappings)
    .values({ externalName: tag(), realModel: `real-${tag()}`, status: 0, inputPrice: '2', outputPrice: '6', cacheInputPrice: '1' })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const [channel] = await db.insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: encrypt('sk-smoke-real', encryptionKey), status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });

  // allowLocalUrl：本地 mock 上游是回环地址——生产 SSRF 防护（拒绝私网/回环）的测试逃生门
  const ai = createAi({ allowLocalUrl: true }, { ...createMemoryAiStorages() });
  const runChat = createRunChat({
    db,
    billing,
    buildQuote: createBuildQuote({ db }),
    resolveChannels: createResolveChannels({ db }),
    upstream: createUpstreamAdapter({ ai, encryptionKey, deadlineMs: 5_000 }),
    config: { reservationLimit: '1000', authorizationTtlMs: 300_000, output: { defaultMax: 4_096, exposureCap: 32_768 } },
  });
  return { app: createApp({ db, runChat, oauth: { jwtSecret: 'gw-test-secret-0123456789abcdef', tokenTtlSeconds: 3_600 } }), raw, userId: user!.id };
}

async function latestReceipt(userId: number): Promise<{ request_id: string; status: string; receipt: Record<string, unknown> | null }> {
  const rows = await db.$client.query(
    'select request_id, status, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
  );
  return rows.rows[0];
}

describe('真上游链路冒烟（mock HTTP + 真适配器）', () => {
  it('非流式：解密→Bearer→协议解析→usage 归一入收据（inputTokens=5/outputTokens=2）', async () => {
    const { app, raw, userId } = await seedAndAssemble();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: await modelOf(userId), messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(json.choices[0]!.message.content).toBe('hello from mock');

    const row = await latestReceipt(userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('settlement_pending');
    expect(row.receipt).toMatchObject({ usage: { inputTokens: 5, outputTokens: 2, estimated: false } });
  });

  it('流式：SSE 透传 + 尾帧 usage 可信收据（stream=true）', async () => {
    const { app, raw, userId } = await seedAndAssemble();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: await modelOf(userId), stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('hel');
    expect(text).toContain('[DONE]');

    // 流收尾是异步事件锚定：等收据落账
    await waitFor(async () => {
      const row = await latestReceipt(userId);
      return row.receipt != null;
    }, 3_000);
    const row = await latestReceipt(userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('settlement_pending');
    expect(row.receipt).toMatchObject({ stream: true, usage: { estimated: false, inputTokens: 5, outputTokens: 2 } });
  });

  it('渠道密钥错（上游 401）→ 真适配器错误归一 → 换渠耗尽 502 + 三路归还', async () => {
    const seeded = await seedAndAssemble();
    // 把渠道密钥改成错误值（重新加密一个假 key）——上游 mock 会 401
    await db.$client.query('update channels set api_key_enc = $1 where id = any($2)', [encrypt('sk-wrong', encryptionKey), createdChannels.slice(-1)]);
    const res = await seeded.app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${seeded.raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: await modelOf(seeded.userId), messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(res.status).toBe(502);
    const row = await latestReceipt(seeded.userId);
    createdRequests.push(row.request_id);
    expect(row.status).toBe('released');
  });
});

/** 该用户最新 mapping 的对外名（seed 顺序即用即取） */
async function modelOf(userId: number): Promise<string> {
  const row = await db.$client.query<{ external_name: string }>(
    'select mm.external_name from model_mappings mm join model_channels mc on mc.mapping_id = mm.id join channels ch on ch.id = mc.channel_id join api_keys k on k.user_id = $1 order by mm.id desc limit 1', [userId],
  );
  if (!row.rows[0]) throw new Error('no seeded model');
  return row.rows[0].external_name;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}
