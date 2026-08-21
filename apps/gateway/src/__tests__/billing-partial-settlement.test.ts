/**
 * 部分交付计费全链回归（真 PG + stub 上游 + 真 settlement domain）：
 * 收据装配（gateway）→ 结算认领（worker 语义）→ 钱包落定 → 账目对账。
 *
 * 覆盖此前缺口的扣款异常面（2026-08-21 归属细分后的新风险）：
 *   1. 新归属值（upstream_error_partial / server_draining / inactivity_timeout）
 *      必须能真正走完 worker 结算（settle.ts:102 白名单端到端）——任何一环
 *      拒绝都会 retry→dead + 预扣永久冻结（用户钱被押死）
 *   2. 部分交付单的钱包终态：余额精确 = 充值 − 估算实扣、在途归零、
 *      releasedRemainder 隐式归还（预扣 > 实扣的差额不搁浅）
 *   3. 0 元结算（上游可信全 0 usage）走 billing_settled_zero 释放路径
 *   4. 并发混合（故障流 × 正常流）无串账：Σ实扣 = 充值 − 终态余额，分毫对账
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import { Decimal } from '@ai-gateway/domain';
import { createBillingDomain, createSettlementDomain, createWallet } from '@ai-gateway/service';
import { systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import type { UpstreamPort, UpstreamResult, UpstreamStreamEvent } from '../pipeline/upstream-port.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 20 },
);
type Db = Awaited<ReturnType<typeof createDb>>;
const ctx: RunContext = systemContext('partial-settle-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const buildQuote = createBuildQuote({ db });
const resolveChannels = createResolveChannels({ db, rng: () => 0 });
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});
const settlement = createSettlementDomain({
  db, currency: 'CNY', wallet,
  policy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

const tag = () => `ps-${randomUUID().slice(0, 8)}`;

async function seedModel(): Promise<{ model: string; channelNames: string[] }> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://ps.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const realModel = `real-${tag()}`;
  const externalName = tag();
  const [mapping] = await db
    .insert(modelMappings)
    .values({ externalName, realModel, status: 0, inputPrice: '2', outputPrice: '6', cacheInputPrice: '1', cacheWritePrice: '5' })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const name = `ch-${tag()}`;
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name, apiKeyEnc: 'enc', status: 0, upstreamBudget: '10000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 100, weight: 1 });
  return { model: externalName, channelNames: [name] };
}

async function newFundedUser(amount = '100'): Promise<{ raw: string; userId: number }> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'ps', subject: `ps-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const { apiKeys } = await import('@ai-gateway/db');
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'ps' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

interface StreamScript {
  frames?: string[];
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteTokens?: number; estimated?: boolean };
  terminated?: string;
  bytesRelayed?: number;
  outputText?: string;
}

function stubUpstream(plan: Record<string, StreamScript>): UpstreamPort {
  return {
    async chat(candidate): Promise<UpstreamResult> {
      const script = plan[candidate.channelName] ?? {};
      return {
        ok: true,
        body: { id: 'chatcmpl-ps', choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        ...(script.usage ? { usage: { ...script.usage } } : {}),
      };
    },
    async chatStream(candidate) {
      const script = plan[candidate.channelName] ?? { frames: ['data: {"a":1}\n\n'] };
      const listeners: Array<(e: UpstreamStreamEvent) => void> = [];
      const emitted: UpstreamStreamEvent[] = [];
      const emit = (e: UpstreamStreamEvent) => {
        emitted.push(e);
        listeners.forEach((cb) => cb(e));
      };
      let firstEmitted = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          for (const frame of script.frames ?? ['data: {"a":1}\n\n']) {
            if (!firstEmitted) {
              firstEmitted = true;
              emit({ type: 'first_chunk', atMs: Date.now() });
            }
            controller.enqueue(encoder.encode(frame));
          }
          emit({
            type: 'success',
            ...(script.usage ? { usage: { estimated: script.usage.estimated ?? false, ...script.usage } } : {}),
            ...(script.terminated !== undefined ? { terminated: script.terminated } : {}),
            ...(script.bytesRelayed !== undefined ? { bytesRelayed: script.bytesRelayed } : {}),
            ...(script.outputText !== undefined ? { outputText: script.outputText } : {}),
          } as UpstreamStreamEvent);
          controller.close();
        },
      });
      return { stream, onEvent: (cb) => { listeners.push(cb); for (const e of emitted) cb(e); } };
    },
  };
}

const config = { reservationLimit: '1000', authorizationTtlMs: 300_000, output: { defaultMax: 4_096, exposureCap: 32_768 } };

function makeApp(upstream: UpstreamPort) {
  return createApp({
    db,
    runChat: createRunChat({ db, billing, buildQuote, resolveChannels, upstream, config }),
    oauth: { jwtSecret: 'gw-ps-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
  });
}

async function postStream(app: ReturnType<typeof makeApp>, raw: string, model: string, content = 'hi'): Promise<string> {
  const res = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content }] }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

async function latestRequestId(userId: number): Promise<string> {
  const found = await db.$client.query<{ request_id: string }>(
    'select request_id from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
  );
  const requestId = found.rows[0]!.request_id;
  if (!createdRequests.includes(requestId)) createdRequests.push(requestId);
  return requestId;
}

/** 驱动结算到终态（幂等容忍：dev 库外部 worker 可能抢先——settled 即成功） */
async function driveToSettled(requestId: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db.$client.query<{ status: string }>('select status from billing_requests where request_id = $1', [requestId]);
    const status = row.rows[0]!.status;
    if (status === 'settled') return;
    if (status === 'dead' || status === 'retry_wait') {
      // 白名单/毒收据会走到这——主动认领重放一次让失败信息浮出
      const claims = await settlement.claim(systemContext(randomUUID()), {
        ownerId: tag(), batchSize: 1, claimLeaseMs: 30_000, requestIds: [requestId],
      });
      if (claims.length > 0) await settlement.processClaim(systemContext(randomUUID()), claims[0]!);
      const after = await db.$client.query<{ status: string; failure_code: string | null }>(
        'select status, failure_code from billing_requests where request_id = $1', [requestId],
      );
      expect(after.rows[0]!.status, `结算异常终态：${after.rows[0]!.failure_code}`).toBe('settled');
      return;
    }
    if (Date.now() > deadline) throw new Error(`settlement not settled within ${timeoutMs}ms (status=${status})`);
    if (status === 'settlement_pending') {
      const claims = await settlement.claim(systemContext(randomUUID()), {
        ownerId: tag(), batchSize: 1, claimLeaseMs: 30_000, requestIds: [requestId],
      });
      if (claims.length > 0) {
        const outcome = await settlement.processClaim(systemContext(randomUUID()), claims[0]!);
        expect(['settled', 'retried']).toContain(outcome);
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

interface FinalState {
  status: string;
  amount: string;
  estimateReason: string | null;
  balance: string;
  inFlight: string;
}

async function finalState(userId: number, requestId: string): Promise<FinalState> {
  const bill = await db.$client.query<{ status: string }>('select status from billing_requests where request_id = $1', [requestId]);
  const usage = await db.$client.query<{ amount: string; estimate_reason: string | null }>(
    'select amount, estimate_reason from usage_logs where request_id = $1', [requestId],
  );
  const accounts = await wallet.accounts(ctx, userId);
  return {
    status: bill.rows[0]!.status,
    amount: usage.rows[0]?.amount ?? '0',
    estimateReason: usage.rows[0]?.estimate_reason ?? null,
    balance: accounts[0]!.balance,
    inFlight: accounts[0]!.inFlight,
  };
}

afterAll(async () => {
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

describe('部分交付计费全链（gateway 收据 → worker 结算 → 钱包落定）', () => {
  it('upstream_error_partial：worker 真实结算 + 钱包精确扣估算额 + 预扣差额隐式归还', async () => {
    const seeded = await seedModel();
    const { raw, userId } = await newFundedUser();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { terminated: 'upstream_error', outputText: '部分交付内容'.repeat(10), bytesRelayed: 200 },
    }));

    await postStream(app, raw, seeded.model, '请计算这道数学题并给出详细步骤');
    const requestId = await latestRequestId(userId);
    await driveToSettled(requestId);

    const state = await finalState(userId, requestId);
    // 白名单端到端：新归属值不被 settle 拒（否则 dead + 预押冻结）
    expect(state.status).toBe('settled');
    expect(state.estimateReason).toBe('upstream_error_partial');
    // 钱包终态：在途清零（预扣>实扣的差额隐式归还），余额精确 = 100 − 实扣
    expect(state.inFlight, '结算后在途必须清零——差额搁浅即预押吞钱').toBe('0');
    expect(new Decimal(state.amount).gt(0), '部分交付必须产生实扣（政策：有输出就扣）').toBe(true);
    expect(new Decimal(state.balance).plus(state.amount).toString()).toBe('100');
  });

  it.each([
    ['server_draining', 'server_draining'],
    ['inactivity', 'inactivity_timeout'],
  ] as const)('归属 %s：结算端到端放行（白名单遗漏 = retry→dead + 预押冻结）', async (terminated, reason) => {
    const seeded = await seedModel();
    const { raw, userId } = await newFundedUser();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { terminated, outputText: '交付片段', bytesRelayed: 24 },
    }));

    await postStream(app, raw, seeded.model);
    const requestId = await latestRequestId(userId);
    await driveToSettled(requestId);

    const state = await finalState(userId, requestId);
    expect(state.status).toBe('settled');
    expect(state.estimateReason).toBe(reason);
    expect(state.inFlight).toBe('0');
  });

  it('0 元结算：上游可信全 0 usage → billing_settled_zero 释放路径，余额不动、在途清零', async () => {
    const seeded = await seedModel();
    const { raw, userId } = await newFundedUser();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } },
    }));

    await postStream(app, raw, seeded.model);
    const requestId = await latestRequestId(userId);
    await driveToSettled(requestId);

    const state = await finalState(userId, requestId);
    expect(state.status).toBe('settled');
    expect(new Decimal(state.amount).isZero(), '0 元结算落账金额为 0（numeric 全精度零）').toBe(true);
    expect(new Decimal(state.balance).eq(100)).toBe(true);
    expect(state.inFlight).toBe('0');
  });

  it('并发混合（4 故障流 + 4 正常流）：Σ实扣 = 充值 − 终态余额，分毫对账无串账', async () => {
    const seeded = await seedModel();
    const { raw, userId } = await newFundedUser();
    // 同渠道交替剧本：偶数次故障流（估算计费）、奇数次正常流（可信 usage 实值计费）
    let callSeq = 0;
    const upstream: UpstreamPort = {
      async chat() { throw new Error('non-stream not used'); },
      async chatStream(candidate) {
        const seq = callSeq++;
        void candidate;
        const listeners: Array<(e: UpstreamStreamEvent) => void> = [];
        const emitted: UpstreamStreamEvent[] = [];
        const emit = (e: UpstreamStreamEvent) => {
          emitted.push(e);
          listeners.forEach((cb) => cb(e));
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"delta":"x"}\n\n'));
            emit({ type: 'first_chunk', atMs: Date.now() });
            emit(seq % 2 === 0
              ? ({ type: 'success', terminated: 'upstream_error', outputText: `故障流交付${seq}`, bytesRelayed: 16 } as UpstreamStreamEvent)
              : ({ type: 'success', usage: { estimated: false, inputTokens: 40 + seq, cachedInputTokens: 0, outputTokens: 5 + seq } } as UpstreamStreamEvent));
            controller.close();
          },
        });
        // 端口契约：start() 同步发的事件必须重放给晚订阅者（chatStream 返回后才注册）
        return { stream, onEvent: (cb) => { listeners.push(cb); for (const e of emitted) cb(e); } };
      },
    };
    const app = makeApp(upstream);

    await Promise.all(Array.from({ length: 8 }, (_, i) => postStream(app, raw, seeded.model, `并发请求${i}`)));
    // 等待全部 8 张账单出现并结算
    await new Promise((r) => setTimeout(r, 300));
    const rows = await db.$client.query<{ request_id: string }>(
      'select request_id from billing_requests where user_id = $1', [userId],
    );
    expect(rows.rows).toHaveLength(8);
    for (const row of rows.rows) {
      createdRequests.push(row.request_id);
      await driveToSettled(row.request_id);
    }

    const usage = await db.$client.query<{ sum: string; reasons: string[] }>(
      'select coalesce(sum(amount), 0)::text as sum, array_agg(distinct estimate_reason) as reasons from usage_logs where request_id = any($1)', [rows.rows.map((r) => r.request_id)],
    );
    const accounts = await wallet.accounts(ctx, userId);
    const totalCharged = new Decimal(usage.rows[0]!.sum);
    // 4 路故障流（估算 > 0）+ 4 路正常流（实值 > 0）= 8 笔全部扣款，两类归属并存
    expect(usage.rows[0]!.reasons).toContain('upstream_error_partial');
    expect(usage.rows[0]!.reasons).toContain(null);
    expect(new Decimal(accounts[0]!.balance).plus(totalCharged).toString(), 'Σ实扣 + 终态余额 必须恰等于充值额（分毫对账）').toBe('100');
    expect(accounts[0]!.inFlight).toBe('0');
  });
});
