/**
 * 【红测】流式收据资金口径两处缺陷（review 2026-08-20）——测试预期失败：
 *
 * R1（资金·高危）：run-chat.ts 流式分支组装收据时丢弃可信 usage 的
 *    cacheWriteTokens（streamReceiptUsage 已产出该字段、端口契约与结算端
 *    computeAmounts 均支持，唯独 receipt 装配点未透传）→ 缓存写 token
 *    全部落入 uncached 段按 inputPrice 计费。当 cacheWritePrice > inputPrice
 *    （Anthropic 官方写价 1.25×/2×）时系统性少收；反向配置则多收。
 *    非流式分支（buildReceipt 直传）口径正确——本文件含对照用例证明这是
 *    流式分支的回归，而非全链路设计如此。
 *
 * R2（政策·资金公平性）：上游流故障中断（terminated='upstream_error'）且
 *    上游未回 usage 时，run-chat 将 estimatedFor 归为 'usage_missing_completed'
 *    （∈ ESTIMATE_ATTRIBUTIONS 白名单）→ 结算端放行估算扣费。这与
 *    domain/rating/types.ts 对 ESTIMATE_ATTRIBUTIONS 的政策注释直接矛盾：
 *    「上游故障中断（超时/5xx/截断）不在此列——那类走释放不扣」。
 *    用户会为上游故障的残缺流买单。
 *
 * 修复后本文件应转绿（断言写的是契约行为，不是现况快照）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { users } from '@ai-gateway/db';
import { estimateInputTokens, estimateTextTokens } from '@ai-gateway/ai';
import type { Db } from '@ai-gateway/repository';
import { computeAmounts, Decimal, type UsageReceipt } from '@ai-gateway/domain';
import { createBillingDomain, createWallet } from '@ai-gateway/service';
import { systemContext, type RunContext } from '@ai-gateway/service';
import { createApp } from '../app.js';
import { createBuildQuote } from '../quote/build-quote.js';
import { createResolveChannels } from '../routing/resolve-channels.js';
import { createRunChat } from '../pipeline/run-chat.js';
import type { UpstreamPort, UpstreamResult, UpstreamStreamEvent } from '../pipeline/upstream-port.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('red-stream-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });
const buildQuote = createBuildQuote({ db });
const resolveChannels = createResolveChannels({ db, rng: () => 0 });
const wallet = createWallet({
  db,
  currency: 'CNY',
  guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
});

const createdUsers: number[] = [];
const createdKeys: number[] = [];
const createdMappings: number[] = [];
const createdChannels: number[] = [];
const createdProviders: number[] = [];
const createdRequests: string[] = [];

const tag = () => `red-st-${randomUUID().slice(0, 8)}`;

/** 定价故意拉开：cacheWritePrice(5) > inputPrice(2)，使 cacheWrite 口径错误直接可见 */
const PRICING = { inputPrice: '2', outputPrice: '6', cacheInputPrice: '1', cacheWritePrice: '5' };

async function seedModelWithCacheWritePricing(): Promise<{ model: string; channelNames: string[] }> {
  const { modelMappings, modelChannels, channels, providers } = await import('@ai-gateway/db');
  const [provider] = await db
    .insert(providers)
    .values({ name: tag(), baseUrl: 'https://red-st.test', protocol: 'openai-compatible', status: 0 })
    .returning({ id: providers.id });
  createdProviders.push(provider!.id);
  const realModel = `real-${tag()}`;
  const externalName = tag();
  const [mapping] = await db
    .insert(modelMappings)
    .values({
      externalName,
      realModel,
      status: 0,
      inputPrice: PRICING.inputPrice,
      outputPrice: PRICING.outputPrice,
      cacheInputPrice: PRICING.cacheInputPrice,
      cacheWritePrice: PRICING.cacheWritePrice,
    })
    .returning({ id: modelMappings.id });
  createdMappings.push(mapping!.id);
  const name = `ch-${tag()}`;
  const [channel] = await db
    .insert(channels)
    .values({ providerId: provider!.id, name, apiKeyEnc: 'enc', status: 0, upstreamBudget: '1000' })
    .returning({ id: channels.id });
  createdChannels.push(channel!.id);
  await db.insert(modelChannels).values({ mappingId: mapping!.id, channelId: channel!.id, priority: 100, weight: 1 });
  return { model: externalName, channelNames: [name] };
}

async function newFundedKey(amount = '100'): Promise<{ raw: string; userId: number }> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'red-st', subject: `red-st-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  await wallet.credit(ctx, { userId: user!.id, amount, refType: 'topup', refId: tag() });
  const raw = `ag_${randomUUID().replace(/-/g, '')}`;
  const { apiKeys } = await import('@ai-gateway/db');
  const [key] = await db
    .insert(apiKeys)
    .values({ keyHash: createHash('sha256').update(raw).digest('hex'), keyPreview: 'ag_****', userId: user!.id, name: 'red-st' })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return { raw, userId: user!.id };
}

interface StreamScript {
  frames: string[];
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; cacheWriteTokens?: number; estimated?: boolean };
  terminated?: string;
  bytesRelayed?: number;
  outputText?: string;
}

/** stub 上游：非流式 spec.usage；流式 spec.stream（支持 cacheWriteTokens 与 terminated——本红测的核心变量） */
function stubUpstream(plan: Record<string, { usage?: StreamScript['usage']; stream?: StreamScript }>): UpstreamPort {
  return {
    async chat(candidate): Promise<UpstreamResult> {
      const spec = plan[candidate.channelName] ?? {};
      return {
        ok: true,
        body: { id: 'chatcmpl-red', choices: [{ message: { role: 'assistant', content: 'ok' } }] },
        ...(spec.usage ? { usage: { ...spec.usage } } : {}),
      };
    },
    async chatStream(candidate) {
      const spec = plan[candidate.channelName] ?? {};
      const script = spec.stream ?? { frames: ['data: {"a":1}\n\n'] };
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
          for (const frame of script.frames) {
            if (!firstEmitted) {
              firstEmitted = true;
              emit({ type: 'first_chunk' });
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

const config = {
  reservationLimit: '1000',
  authorizationTtlMs: 300_000,
  output: { defaultMax: 4_096, exposureCap: 32_768 },
};

function makeApp(upstream: UpstreamPort) {
  return createApp({
    db,
    runChat: createRunChat({ db, billing, buildQuote, resolveChannels, upstream, config }),
    oauth: { jwtSecret: 'gw-red-secret-0123456789abcdef', tokenTtlSeconds: 3_600 },
  });
}

async function postChat(app: ReturnType<typeof makeApp>, raw: string, body: Record<string, unknown>) {
  return app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 该用户最新账单行（requestId 由中间件生成，从 DB 侧取证） */
async function latestBillingRow(userId: number): Promise<{ request_id: string; status: string; receipt: Record<string, unknown> | null }> {
  const found = await db.$client.query<{ request_id: string; status: string; receipt: Record<string, unknown> | null }>(
    'select request_id, status, receipt from billing_requests where user_id = $1 order by created_at desc limit 1', [userId],
  );
  const row = found.rows[0]!;
  if (!createdRequests.includes(row.request_id)) createdRequests.push(row.request_id);
  return row;
}

async function waitForStatus(userId: number, statuses: string[], timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await latestBillingRow(userId);
    if (statuses.includes(row.status)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
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

/** 断言口径归一：除以收据 coefficient（费率卡可能非 1），得到「官方价金额」便于精确比对 */
function normalizedCalculated(receipt: Record<string, unknown>): string {
  const amounts = computeAmounts(receipt as unknown as UsageReceipt);
  return new Decimal(amounts.calculatedAmount).div(new Decimal(String(receipt.coefficient ?? '1'))).toString();
}

describe('R1 流式收据丢 cacheWriteTokens（资金口径回归）', () => {
  const USAGE = { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, cacheWriteTokens: 500 };
  /** 正确口径：(uncached 500×2 + write 500×5 + output 100×6)/1M = (1000+2500+600)/1e6 = 0.0041 */
  const EXPECTED_AMOUNT = '0.0041';
  /** 现况口径（cacheWrite 并入 uncached）：(1000×2 + 100×6)/1e6 = 0.0026 —— 少收 36.6% */
  const BUGGY_AMOUNT = '0.0026';

  it('流式：可信 usage 带 cacheWriteTokens=500 → 收据应保留该字段且金额按写价计', async () => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: { stream: { frames: ['data: {"delta":"你"}\n\n', 'data: [DONE]\n\n'], usage: USAGE } },
    }));

    const res = await postChat(app, raw, { model: seeded.model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await res.text();
    await waitForStatus(userId, ['settlement_pending', 'settled']);

    const row = await latestBillingRow(userId);
    const receipt = row.receipt!;
    // 断言 1：收据保留上游可信回传的 cacheWriteTokens（端口契约与结算公式均消费该字段）
    expect(receipt.usage, `流式收据 usage 应含 cacheWriteTokens（现况被 run-chat 装配点丢弃）：${JSON.stringify(receipt.usage)}`).toMatchObject({ cacheWriteTokens: 500, estimated: false });
    // 断言 2：结算金额按缓存写价（5/M）计，而非按输入价（2/M）把写 token 并入 uncached
    const amount = normalizedCalculated(receipt);
    expect(amount, `实扣应为 ${EXPECTED_AMOUNT}（写价口径）；若得 ${BUGGY_AMOUNT} 即 cacheWrite 并入 uncached 按输入价计费的回归`).toBe(EXPECTED_AMOUNT);
  });

  it('非流式对照：同一 usage → cacheWriteTokens 保留、金额正确（证明非流式无此回归）', async () => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({ [seeded.channelNames[0]!]: { usage: USAGE } }));

    const res = await postChat(app, raw, { model: seeded.model, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await res.json();
    await waitForStatus(userId, ['settlement_pending', 'settled']);

    const receipt = (await latestBillingRow(userId)).receipt!;
    expect(receipt.usage).toMatchObject({ cacheWriteTokens: 500, estimated: false });
    expect(normalizedCalculated(receipt)).toBe(EXPECTED_AMOUNT);
  });
});

describe('R2 上游流故障部分交付 → 估算扣费（政策锁定：2026-08-21 拍板「有输出就扣」', () => {
  /** 部分交付计费政策（types.ts ESTIMATE_ATTRIBUTIONS 注释）：上游已处理即扣 input、
   *  已交付输出按文本加扣；零交付（first_chunk 前）不扣走释放。
   *  金额口径契约：估算实扣向「精确」收敛——input/output 均走 BPE 估算，
   *  保守字节上界只用于预扣，不得用作实扣（否则故障流 input 多收 4-6×，
   *  出现「残缺交付比完整交付贵」的反直觉账单）。 */
  const PARTIAL_TEXT = '部分内容已交付给用户。'.repeat(20);
  const LONG_INPUT = '请总结以下合同中的违约责任条款与争议解决条款，并指出对我方不利的内容。'.repeat(12);

  it('terminated=upstream_error 且无 usage → settlement_pending + 估算收据（input=BPE 口径、output=已交付文本 BPE 估算）', async () => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: {
          // 上游流中途抛错帧后断流：已转发部分内容但从未回 usage（真实故障形态）
          frames: ['data: {"delta":"…"}\n\n', 'data: {"error":{"code":"upstream_error"}}\n\n'],
          terminated: 'upstream_error',
          bytesRelayed: 512,
          outputText: PARTIAL_TEXT,
        },
      },
    }));

    const reqBody = { model: seeded.model, stream: true, messages: [{ role: 'user', content: LONG_INPUT }] };
    const res = await postChat(app, raw, reqBody);
    expect(res.status).toBe(200);
    await res.text();
    await waitForStatus(userId, ['settlement_pending', 'settled', 'released']);

    const row = await latestBillingRow(userId);
    // 政策锁定：部分交付即计费（不走释放）
    expect(row.status, '有输出的故障流应进入结算（settlement_pending/settled），不得释放').not.toBe('released');
    const receipt = row.receipt as {
      estimatedFor?: string; streamAborted?: boolean;
      usage?: { estimated: boolean; inputTokens: number; outputTokens: number };
    };
    // 归属细分（2026-08-21）：上游故障部分交付 ≠ 正常完成缺 usage——报表/客服可区分
    expect(receipt.estimatedFor).toBe('upstream_error_partial');
    expect(receipt.usage!.estimated).toBe(true);
    expect(receipt.streamAborted).toBe(true);

    // 口径锁定 1：input 实扣 = BPE 估算（与预扣同一估算器），不得用 JSON 字节保守上界
    const expectedInput = estimateInputTokens(reqBody, { model: seeded.model });
    const byteBound = Buffer.byteLength(JSON.stringify(reqBody), 'utf8');
    expect(
      receipt.usage!.inputTokens,
      `input 实扣应为 BPE 口径 ${expectedInput}；若 ≈ 字节上界 ${byteBound}（约 ${(byteBound / expectedInput).toFixed(1)}× BPE）即「故障流 input 多收数倍」回归`,
    ).toBe(expectedInput);

    // 口径锁定 2：output 实扣 = 已交付文本的 BPE 估算（启发式对 CJK 高估 ~40%）
    const expectedOutput = estimateTextTokens(PARTIAL_TEXT, undefined, seeded.model);
    expect(
      receipt.usage!.outputTokens,
      `output 实扣应为 BPE 口径 ${expectedOutput}；若 ≈ 启发式 ${estimateTextTokens(PARTIAL_TEXT)} 即估算器漏传 model 回归`,
    ).toBe(expectedOutput);
  });

  it('非流式缺 usage 同口径：input 实扣 = BPE 估算（非字节上界）', async () => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({ [seeded.channelNames[0]!]: {} })); // 无 usage → usage_missing_nonstream

    const reqBody = { model: seeded.model, messages: [{ role: 'user', content: LONG_INPUT }] };
    const res = await postChat(app, raw, reqBody);
    expect(res.status).toBe(200);
    await res.json();
    await waitForStatus(userId, ['settlement_pending', 'settled']);

    const receipt = (await latestBillingRow(userId)).receipt as {
      estimatedFor?: string; usage?: { estimated: boolean; inputTokens: number };
    };
    expect(receipt.estimatedFor).toBe('usage_missing_nonstream');
    expect(receipt.usage!.inputTokens).toBe(estimateInputTokens(reqBody, { model: seeded.model }));
  });

  /** 归属细分端到端：同一条估算计费管道，不同 terminated 映射不同 estimateReason */
  it.each([
    ['server_draining', 'server_draining'],
    ['inactivity', 'inactivity_timeout'],
  ] as const)('归属细分：terminated=%s → estimatedFor=%s', async (terminated, expectedFor) => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: {
          frames: ['data: {"delta":"x"}\n\n'],
          terminated,
          outputText: '部分交付',
          bytesRelayed: 32,
        },
      },
    }));

    const res = await postChat(app, raw, { model: seeded.model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await res.text();
    await waitForStatus(userId, ['settlement_pending', 'settled']);

    const receipt = (await latestBillingRow(userId)).receipt as { estimatedFor?: string };
    expect(receipt.estimatedFor, `terminated=${terminated} 应映射独立归属（白名单放行 + 报表可查）`).toBe(expectedFor);
  });

  it('归属兼容：用户侧取消（client_disconnect）保持历史口径不漂移', async () => {
    const seeded = await seedModelWithCacheWritePricing();
    const { raw, userId } = await newFundedKey();
    const app = makeApp(stubUpstream({
      [seeded.channelNames[0]!]: {
        stream: { frames: ['data: {"delta":"x"}\n\n'], terminated: 'client_disconnect', outputText: '已交付', bytesRelayed: 32 },
      },
    }));

    const res = await postChat(app, raw, { model: seeded.model, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(200);
    await res.text();
    await waitForStatus(userId, ['settlement_pending', 'settled']);

    const receipt = (await latestBillingRow(userId)).receipt as { estimatedFor?: string };
    expect(receipt.estimatedFor).toBe('client_disconnect');
  });
});
