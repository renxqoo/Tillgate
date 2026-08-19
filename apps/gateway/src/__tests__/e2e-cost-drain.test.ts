/**
 * E2E 刷费用专项（本地可控 mock 上游 + 真适配器 + 真计费全链）——「让用户无限刷
 * 平台上游费用」的每一个已知向量的闭环验证：
 *
 *   ① max_tokens 超口径声明 → 转发体被钳到预扣口径（预估敞口 ≥ 实际输出上限）
 *   ② 流式取消 + 无逐帧 usage → 输出 token 按累计内容估算收费（输出≠0——旧口径
 *      输出恒 0 = 「拉满输出再掐线」白嫖面）
 *   ③ 流式完成但上游不给 usage（忽略 include_usage 的供应商）→ 输出估算收费
 *   ④ 逐帧累计 usage 后取消 → 用最后一帧 usage 精确收费（不估算）
 *   ⑤ 余额不足且未声明 balanceFloor → 402 整单拒绝（无预扣无上游调用——零损失）
 *   ⑥ 声明 balanceFloor 的低价放行 + 实际用量远超余额 → 结算收满预留不死信、
 *      不搁浅（差额=有界损失，钱包清零在途清零）
 *   ⑦ 上游重试幂等键（Idempotency-Key = requestId）注入——防响应丢失重试双花上游
 */
import { createServer, type Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apiKeys, modelChannels, modelMappings, channels, providers, users } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { encrypt } from '@ai-gateway/core';
import { createAi } from '@ai-gateway/ai';
import { Decimal } from '@ai-gateway/domain';
import {
  createBillingDomain,
  createSettlementDomain,
  createWallet,
  systemContext,
  type RunContext,
} from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import { createUpstreamAdapter } from '../pipeline/upstream-adapter.js';
import { createMemoryAiStorages } from '../pipeline/ai-storages.js';

const encryptionKey = 'drain-key-0123456789abcdef';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const tag = () => `v2drain-${randomUUID().slice(0, 8)}`;

const wallet = createWallet({
  db, currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});
const billing = createBillingDomain({ db, currency: 'CNY' });
const settlement = createSettlementDomain({
  db, currency: 'CNY',
  policy: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];

// ---- mock 上游：脚本化响应 + 请求录制（体/头全量留证）----
type RecordedRequest = { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };
const recorded: RecordedRequest[] = [];
/** 当前脚本（每个用例独占设置；null = 默认非流式 usage 应答） */
let script: 'nonstream-usage' | 'stream-no-usage-hold' | 'stream-done-no-usage' | 'stream-cumulative-usage-hold' | 'nonstream-huge-usage' | null = null;
let server: Server;
let upstreamBaseUrl = '';

/** 200 个 CJK 字的增量内容（估算口径：0.7 token/字 → ≥100 token） */
const cjkDeltas = Array.from({ length: 20 }, () => '数'.repeat(10));

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Bearer sk-drain-real') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      recorded.push({ headers: { ...req.headers }, body });
      const sse = (frames: string[], hold = false) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const f of frames) res.write(f);
        if (!hold) res.end('data: [DONE]\n\n');
        // hold = 挂住连接等客户端取消（或 inactivity 超时兜底）
      };
      switch (script) {
        case 'stream-no-usage-hold':
          sse(cjkDeltas.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`), true);
          return;
        case 'stream-cumulative-usage-hold':
          sse(cjkDeltas.map((t, i) => `data: ${JSON.stringify({
            choices: [{ delta: { content: t } }],
            usage: { prompt_tokens: 50, completion_tokens: (i + 1) * 5, total_tokens: 50 + (i + 1) * 5 },
          })}\n\n`), true);
          return;
        case 'stream-done-no-usage':
          sse([
            ...cjkDeltas.map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`),
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
          ]);
          return;
        case 'nonstream-huge-usage':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-drain',
            choices: [{ message: { role: 'assistant', content: 'x' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1_000, completion_tokens: 100_000, total_tokens: 101_000 },
          }));
          return;
        default:
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            id: 'chatcmpl-drain',
            choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  upstreamBaseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.closeAllConnections?.() ?? resolve());
  await new Promise<void>((resolve) => server.close(() => resolve()));
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

/** 高价映射（放大金额向量）+ 可选预扣策略；返回外部模型名 */
async function seedMapping(opts: { balanceFloor?: string } = {}): Promise<string> {
  const [provider] = await db.insert(providers)
    .values({ name: tag(), baseUrl: upstreamBaseUrl, protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const externalName = tag();
  const [mapping] = await db.insert(modelMappings)
    .values({
      externalName,
      realModel: `real-${tag()}`,
      status: 0,
      inputPrice: '60',
      outputPrice: '600',
      cacheInputPrice: '1',
      ...(opts.balanceFloor != null
        ? { billingConfig: { reservation: { strategy: 'floor', params: { balance: opts.balanceFloor } } } }
        : {}),
    })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const [channel] = await db.insert(channels)
    .values({ providerId: provider!.id, name: tag(), apiKeyEnc: encrypt('sk-drain-real', encryptionKey), status: 0, upstreamBudget: '100000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 1, weight: 1 });
  return externalName;
}

async function seedUser(amount: string): Promise<{ raw: string; userId: number }> {
  const [user] = await db.insert(users).values({ issuer: 'v2drain', subject: tag(), identityProvider: 'local' }).returning({ id: users.id });
  createdUsers.push(user!.id);
  if (new Decimal(amount).gt(0)) {
    await wallet.credit(systemContext(randomUUID()) as RunContext, {
      userId: user!.id, amount, refType: 'topup', refId: tag(),
    });
  }
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const [key] = await db.insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'v2drain' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

function buildApp() {
  const ai = createAi({ allowLocalUrl: true }, { ...createMemoryAiStorages() });
  const runChat = createRunChat({
    db,
    billing,
    buildQuote: createBuildQuote({ db }),
    resolveChannels: createResolveChannels({ db }),
    upstream: createUpstreamAdapter({ ai, encryptionKey, deadlineMs: 8_000 }),
    config: { reservationLimit: '1000', authorizationTtlMs: 300_000, output: { defaultMax: 4_096, exposureCap: 32_768 } },
  });
  return createApp({ db, runChat, oauth: { jwtSecret: 'drain-test-secret-0123456789ab', tokenTtlSeconds: 3_600 } });
}

async function latestReceipt(userId: number): Promise<{ request_id: string; status: string; receipt: Record<string, unknown> | null; reserved_amount: string }> {
  const rows = await db.$client.query(
    'select request_id, status, reserved_amount, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
  );
  return rows.rows[0];
}

/** 等待收据落库（流式终态信号是响应完成后的异步动作——不是同步可见） */
async function awaitReceipt(userId: number, timeoutMs = 5_000): Promise<NonNullable<Awaited<ReturnType<typeof latestReceipt>>>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bill = await latestReceipt(userId);
    if (bill?.receipt != null) return bill;
    if (Date.now() > deadline) throw new Error(`收据未落库：${JSON.stringify(bill)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function settleAll(userId: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const pending = await db.$client.query<{ request_id: string }>(
      "select request_id from billing_requests where user_id = $1 and status in ('settlement_pending','retry_wait','processing') limit 50", [userId],
    );
    if (pending.rows.length === 0) return;
    const claims = await settlement.claim(systemContext(randomUUID()) as RunContext, {
      ownerId: `drain-${randomUUID().slice(0, 8)}`, batchSize: 50, claimLeaseMs: 60_000,
      requestIds: pending.rows.map((r) => r.request_id),
    });
    for (const claim of claims) await settlement.processClaim(systemContext(randomUUID()) as RunContext, claim);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function walletOf(userId: number): Promise<{ balance: string; inFlight: string }> {
  const rows = await wallet.accounts(systemContext(randomUUID()) as RunContext, userId);
  return { balance: rows[0]!.balance, inFlight: rows[0]!.inFlight };
}

const post = (app: ReturnType<typeof createApp>, raw: string, body: Record<string, unknown>) =>
  app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('E2E 刷费用专项 · 上游对接硬边界', () => {
  it('① max_tokens 超口径声明（1,000,000）→ 转发体钳到 exposureCap（32,768）；n=4 按每路口径钳', async () => {
    const app = buildApp();
    const external = await seedMapping();
    const { raw } = await seedUser('100');
    script = 'nonstream-usage';
    recorded.length = 0;

    const res = await post(app, raw, { model: external, max_tokens: 1_000_000, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const upstreamBody = recorded.at(-1)!.body as { max_tokens?: number };
    expect(upstreamBody.max_tokens).toBe(32_768); // 预扣口径（default 4096 × cap 32768 → 32768）

    // n=4：每路口径 = 32768/4
    recorded.length = 0;
    const res4 = await post(app, raw, { model: external, max_tokens: 1_000_000, n: 4, messages: [{ role: 'user', content: 'hi' }] });
    expect(res4.status).toBe(200);
    const upstreamBody4 = recorded.at(-1)!.body as { max_tokens?: number };
    expect(upstreamBody4.max_tokens).toBe(8_192);
  }, 30_000);

  it('⑦ 上游请求带 Idempotency-Key（= requestId）——重试不双花上游', async () => {
    const app = buildApp();
    const external = await seedMapping();
    const { raw } = await seedUser('100');
    script = 'nonstream-usage';
    const res = await post(app, raw, { model: external, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(typeof recorded.at(-1)!.headers['idempotency-key']).toBe('string');
  }, 30_000);

  it('⑤ 余额不足且未声明 balanceFloor → 402 整单拒绝、零账单零上游调用', async () => {
    const app = buildApp();
    const external = await seedMapping();
    const { raw, userId } = await seedUser('0.5');
    script = 'nonstream-usage';
    recorded.length = 0;
    // 高价模型 + 4096 输出上限的保守预估 ≈ ¥2.5+ >> 0.5 → 足额 fail-closed
    const res = await post(app, raw, { model: external, max_tokens: 4_096, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(402);
    const bills = await db.$client.query('select * from billing_requests where user_id = $1', [userId]);
    expect(bills.rows.length).toBe(0);
    expect(recorded.length).toBe(0); // 上游一次都没被调——平台零损失
  }, 30_000);

  it('⑥ balanceFloor 低价放行 + 实际用量远超余额 → 收满预留、不死信不搁浅', async () => {
    const app = buildApp();
    const external = await seedMapping({ balanceFloor: '0.1' });
    const { raw, userId } = await seedUser('0.5');
    script = 'nonstream-huge-usage'; // 实际 100k 输出 token × ¥600/M = ¥60 >> 预留 0.5

    const res = await post(app, raw, { model: external, max_tokens: 4_096, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await settleAll(userId);

    const bill = await latestReceipt(userId);
    expect(bill.status).toBe('settled'); // 不是 dead / 不是 settlement_pending 滞留
    // 实扣口径按真实 usage（60 元级）落 usage_logs；钱包只收得进预留（0.5）
    const usage = await db.$client.query<{ amount: string }>(
      'select amount::text from usage_logs where user_id = $1', [userId],
    );
    expect(new Decimal(usage.rows[0]!.amount).gt(50)).toBe(true);
    const w = await walletOf(userId);
    expect(new Decimal(w.balance).lte('0.01')).toBe(true); // 收满预留（≈全余额）
    expect(w.inFlight).toBe('0'); // 在途清零——无资金搁浅
  }, 60_000);
});

describe('E2E 刷费用专项 · 流式计量闭环', () => {
  it('② 流式中途取消 + 上游无逐帧 usage → 输出按累计内容估算收费（≠0）', async () => {
    const app = buildApp();
    const external = await seedMapping({ balanceFloor: '0.1' });
    const { raw, userId } = await seedUser('100');
    script = 'stream-no-usage-hold';

    const res = await post(app, raw, { model: external, max_tokens: 4_096, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // 读到首批增量后掐线（模拟「拉满输出再断开」的攻击形态）
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel('user abort').catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    const bill = await awaitReceipt(userId);
    expect(bill.status).toBe('settlement_pending');
    const receipt = bill.receipt as unknown as { usage: { estimated: boolean; outputTokens: number; inputTokens: number }; estimatedFor: string; streamAborted: boolean };
    expect(receipt.usage.estimated).toBe(true);
    expect(receipt.estimatedFor).toBe('client_disconnect');
    expect(receipt.streamAborted).toBe(true);
    expect(receipt.usage.outputTokens).toBeGreaterThanOrEqual(100); // 200 个 CJK 字 ≈ 140 token（旧口径恒 0 = 白嫖面）

    await settleAll(userId);
    const usage = await db.$client.query<{ amount: string }>('select amount::text from usage_logs where user_id = $1', [userId]);
    // 输出估算量 × ¥600/M ≥ ¥0.08，加上输入费用——总扣费必须为正且显著
    expect(new Decimal(usage.rows[0]!.amount).gt('0.05')).toBe(true);
    const w = await walletOf(userId);
    expect(w.inFlight).toBe('0');
  }, 60_000);

  it('③ 流式完成但上游不给 usage → 输出估算收费（usage_missing_completed ≠ 免单）', async () => {
    const app = buildApp();
    const external = await seedMapping({ balanceFloor: '0.1' });
    const { raw, userId } = await seedUser('100');
    script = 'stream-done-no-usage';

    const res = await post(app, raw, { model: external, max_tokens: 4_096, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await res.text(); // 读完整个流（正常完成形态）

    const bill = await awaitReceipt(userId);
    const receipt = bill.receipt as unknown as { usage: { estimated: boolean; outputTokens: number }; estimatedFor: string };
    expect(receipt.usage.estimated).toBe(true);
    expect(receipt.estimatedFor).toBe('usage_missing_completed');
    expect(receipt.usage.outputTokens).toBeGreaterThanOrEqual(100);

    await settleAll(userId);
    const usage = await db.$client.query<{ amount: string }>('select amount::text from usage_logs where user_id = $1', [userId]);
    expect(new Decimal(usage.rows[0]!.amount).gt('0.05')).toBe(true);
    const w = await walletOf(userId);
    expect(w.inFlight).toBe('0');
  }, 60_000);

  it('④ 逐帧累计 usage 后取消 → 最后一帧 usage 精确收费（不估算不白嫖）', async () => {
    const app = buildApp();
    const external = await seedMapping({ balanceFloor: '0.1' });
    const { raw, userId } = await seedUser('100');
    script = 'stream-cumulative-usage-hold';

    const res = await post(app, raw, { model: external, max_tokens: 4_096, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    await new Promise((r) => setTimeout(r, 300)); // 让若干累计帧流过
    await reader.cancel('user abort').catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    const bill = await awaitReceipt(userId);
    const receipt = bill.receipt as unknown as { usage: { estimated: boolean; outputTokens: number; inputTokens: number } };
    expect(receipt.usage.estimated).toBe(false); // 累计 usage 是可信计量
    expect(receipt.usage.inputTokens).toBe(50);
    expect(receipt.usage.outputTokens).toBeGreaterThan(0);

    await settleAll(userId);
    const usage = await db.$client.query<{ amount: string }>('select amount::text from usage_logs where user_id = $1', [userId]);
    const expected = new Decimal(50).times(60).plus(new Decimal(receipt.usage.outputTokens).times(600)).div(1_000_000);
    expect(new Decimal(usage.rows[0]!.amount).eq(expected)).toBe(true); // 分毫=公式
    const w = await walletOf(userId);
    expect(w.inFlight).toBe('0');
  }, 60_000);
});
