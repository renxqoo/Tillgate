/**
 * E2E 智能路由 × 流式请求故障切换与取消（首字节前/首字节后两个窗口的分界语义）。
 *
 * 契约事实来源（先读代码后写断言——键名/常量/语义均以实现为准）：
 *   - packages/inference/src/application/stream.ts：createStreamAttempt 以
 *     first_chunk/failed/success 决定性事件锚定换渠窗口——first_chunk 前失败经
 *     dispatchFailure 可换渠；first_chunk 后管道立即交还路由（不再换渠），
 *     终态（含 client_disconnect）在后台结算。
 *   - packages/ai/src/retry/with-retry.ts：maxAttempts 含首次调用（inference 传
 *     maxRetries = policy.retry.sameChannelMaxRetries = 3 → 单渠道最多 3 次上游
 *     调用，不是「3 次重试 = 4 次调用」）；重试仅首字节前。
 *   - packages/inference/src/health/penalty.ts + routing-memory.ts：惩罚键
 *     inference:health:penalty:ch:{channelId}；quota_exhausted 冷却 =
 *     policy.penalty.quotaMs（缺省 1_800_000ms = 30 分钟）。
 *   - packages/ai/src/errors/fallback.ts statusKind：402 → quota_exhausted（不可
 *     同渠道重试、可换渠）、5xx → upstream_error（可同渠道重试、可换渠）、
 *     429 → rate_limited（可同渠道重试、可换渠）。
 *   - packages/ai/src/transport/http-client.ts fetchUpstream：connectMs 覆盖
 *     「建连 + 响应头」——慢响应头在此超时并归 kind=timeout（可换渠）；
 *     外部信号（withRetry deadline）中止归 kind=canceled（不可换渠，见场景④b观察）。
 *   - packages/inference/src/domain/usage/receipt-usage.ts：取消但已有可信累计
 *     usage（stream-usage-hold 的增量帧携带 usage）→ 按最新 usage 正常结算，
 *     stream_aborted=false、不估算。
 *   - 计价（packages/billing/src/domain/rating/pricing.ts）：amount =
 *     (input×输入价 + output×输出价)/1e6 × 系数（种子映射 2.1/8.4、无费率卡 → 系数 1）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { Decimal } from '@tillgate/billing';
import { createCipher } from '@tillgate/runtime';
import {
  defined,
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_MODEL,
  E2E_REAL_MODEL,
  e2ePost,
  resetChannelHealth,
  setupE2EWorld,
  sleep,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';
import { E2E_UPSTREAM_KEY, startMockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

let world: E2EWorld;
/** 缺省预算网关（connect 10s / deadline 120s——场景①②③⑤⑥） */
let gateway: E2EGateway;
/** 紧 connect 网关（1.5s）：慢响应头 → kind=timeout → 同渠道重试耗尽后换渠（场景④） */
let tightConnectGw: E2EGateway;
/** 紧 deadline 网关（2s）：deadline 中止的慢首字节渠道——行为观察（场景④b） */
let tightDeadlineGw: E2EGateway;
let keys: E2EKeys;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

// ---------------------------------------------------------------------------
// 渠道/账单/Redis 观测助手
// ---------------------------------------------------------------------------

/** 在世界目录追加渠道并绑定 E2E_MODEL（priority 大者先试——smart-routing ① 锁定的调度序） */
async function addChannel(input: {
  name: string;
  baseUrl: string;
  apiKeyPlain?: string;
  priority: number;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget)
    values (${world.seed.providerId}, ${input.name},
            ${cipher.encrypt(input.apiKeyPlain ?? E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, 1, '1000')
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${world.seed.mappingId}, ${id}, ${E2E_REAL_MODEL})`);
  return id;
}

/** Redis 健康键原始值（惩罚箱/熔断状态机 JSON——fire-and-forget 记账需有界等待） */
async function healthKeyOf(gw: E2EGateway, key: string): Promise<Record<string, unknown> | null> {
  const raw = await gw.assembly.redis.get(`inference:health:${key}`);
  return raw == null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** 有界等待：probe 返回真值即通过；超时抛错（时序敏感断言不写死 sleep） */
async function waitFor<T>(
  label: string,
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`bounded wait timeout: ${label}`);
    await sleep(100);
  }
}

/** 驱动结算直至该用户账单全部 settled（终态 signal 是异步的——循环驱动 + 有界） */
async function awaitSettled(userId: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await keys.settleAll(userId);
    const bills = await keys.billsOf(userId);
    if (bills.length > 0 && bills.every((b) => b.status === 'settled')) return;
    if (Date.now() > deadline) throw new Error(`settle wait timeout (bills=${bills.length})`);
    await sleep(200);
  }
}

/** 用户 usage_logs 行（渠道归属/token/金额/流式旗标——结算证据面；bigint 列 ::text 归一字符串） */
async function usageRowsOf(userId: number): Promise<
  Array<{
    channel_id: string;
    input_tokens: string;
    output_tokens: string;
    amount: string;
    stream: boolean;
    stream_aborted: boolean;
    estimated: boolean;
  }>
> {
  const rows = await world.db.execute(sql`
    select channel_id::text as channel_id, input_tokens::text as input_tokens,
           output_tokens::text as output_tokens, amount::text as amount,
           stream, stream_aborted, estimated
    from usage_logs where user_id = ${userId}`);
  return rows as Array<{
    channel_id: string;
    input_tokens: string;
    output_tokens: string;
    amount: string;
    stream: boolean;
    stream_aborted: boolean;
    estimated: boolean;
  }>;
}

/** 渠道进货额度在途预留（取消/换渠泄漏观测点：结算完成后必须归零） */
async function reservedOf(channelId: number): Promise<string> {
  const rows = await world.db.execute<{ r: string }>(sql`
    select coalesce(upstream_reserved, 0)::text as r from channels where id = ${channelId}`);
  return defined(rows[0], `channel ${channelId}`).r;
}

// ---------------------------------------------------------------------------
// SSE 出站观测助手
// ---------------------------------------------------------------------------

/** 解析客户端收到的 SSE data 帧（保真观测：帧序/帧源/错误帧混入判定） */
function sseFrames(text: string): Array<Record<string, unknown>> {
  return [...text.matchAll(/^data: (\{.*\})$/gm)].map(
    (m) => JSON.parse(String(m[1])) as Record<string, unknown>,
  );
}

const deltaContentOf = (frame: Record<string, unknown>): string => {
  const choices = frame.choices as Array<{ delta?: { content?: string } }> | undefined;
  return choices?.[0]?.delta?.content ?? '';
};

const usageCompletionOf = (frame: Record<string, unknown>): number | undefined => {
  const usage = frame.usage as { completion_tokens?: number } | undefined;
  return usage?.completion_tokens;
};

/** 断言「干净的单源流」：无错误帧、内容恰为 stream-usage 脚本的 200 个 CJK 字、唯一 [DONE] 收尾 */
function expectCleanRelayStream(text: string): void {
  const frames = sseFrames(text);
  expect(frames.length).toBeGreaterThanOrEqual(2); // 20 增量帧 + 终帧
  expect(frames.some((f) => f.error !== undefined)).toBe(false); // 无错帧混入
  expect(frames.map(deltaContentOf).join('')).toBe('数'.repeat(20 * 10));
  expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
  expect(text.match(/data: \[DONE\]/g)).toHaveLength(1); // 唯一收尾（无双重流拼接）
}

// ---------------------------------------------------------------------------
// 私有装置：挂住型流式上游（带连接关闭计数——网关取消传播的确定性观测点）
// ---------------------------------------------------------------------------

interface HoldUpstream {
  url: string;
  /** 收到的请求数 */
  recorded: number;
  /** 未正常收尾即被关闭的连接数（网关取消上游 fetch → socket 销毁） */
  closed: number;
  ready: Promise<void>;
  close(): Promise<void>;
}

/** 与 upstream.ts 的 stream-usage-hold 同形增量帧（usage 累计：prompt 50 / completion 5n） */
const holdFrame = (completion: number): string =>
  `data: ${JSON.stringify({
    choices: [{ delta: { content: '数'.repeat(10) } }],
    usage: { prompt_tokens: 50, completion_tokens: completion, total_tokens: 50 + completion },
  })}\n\n`;

/** 流式挂住上游：首帧立即写出、后续每 frameGapMs 一帧，永不收尾（取消向量专用） */
function startHoldUpstream(frameGapMs: number): HoldUpstream {
  const state: HoldUpstream = {
    url: '',
    recorded: 0,
    closed: 0,
    ready: Promise.resolve(),
    close: async () => {},
  };
  const server: Server = createServer((req, res) => {
    if ((req.headers.authorization ?? '') !== `Bearer ${E2E_UPSTREAM_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad upstream key' } }));
      return;
    }
    req.on('data', () => {}); // 消费请求体（否则 'end' 不触发——node 流暂停语义）
    req.on('end', () => {
      state.recorded += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let completion = 0;
      const writeNext = (): void => {
        completion += 5;
        res.write(holdFrame(completion));
      };
      writeNext(); // 首帧立即（客户端读到首批帧后 abort——取消点确定性）
      const timer = setInterval(writeNext, frameGapMs);
      // 挂住连接的关闭只能是下游取消（未 end 的响应不会自然 close）
      res.on('close', () => {
        clearInterval(timer);
        if (!res.writableEnded) state.closed += 1;
      });
    });
  });
  state.ready = new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      state.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
  state.close = async () => {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };
  return state;
}

// ---------------------------------------------------------------------------
// 世界装配
// ---------------------------------------------------------------------------

/** 限流闸 fail-closed：Redis 握手完成前请求会 400——显式等待收敛（smart-routing 同防线） */
async function awaitRedis(gw: E2EGateway): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if ((await gw.assembly.redis.ping().catch(() => '')) === 'PONG') return;
    await sleep(100);
  }
}

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  // 辅助网关压低连接池（单请求负载足够；避免三网关 3×40 连接池挤爆本地 PG max_connections）
  tightConnectGw = await startE2EGateway(world, {
    GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS: '1500',
    DB_POOL_MAX: '10',
  });
  tightDeadlineGw = await startE2EGateway(world, {
    GATEWAY_UPSTREAM_DEADLINE_MS: '2000',
    DB_POOL_MAX: '10',
  });
  await Promise.all([gateway, tightConnectGw, tightDeadlineGw].map(awaitRedis));
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
}, 180_000);

afterAll(async () => {
  if (tightDeadlineGw) await tightDeadlineGw.stop();
  if (tightConnectGw) await tightConnectGw.stop();
  if (gateway) await gateway.stop();
  if (world) await world.teardown();
});

beforeEach(async () => {
  // 惩罚/熔断键在共享 Redis；场景隔离：清健康键 + 解绑上一场景渠道（渠道行保留无害）
  await resetChannelHealth(gateway);
  await world.db.execute(
    sql`delete from model_channels where mapping_id = ${world.seed.mappingId}`,
  );
});

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

describe.skipIf(!hasEnv)('E2E 流式故障切换与取消', () => {
  it('① 流式首字节前 402：客户端无感换渠（单源干净 SSE）+ A 进 30 分钟惩罚；非流式同分类', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.script = 'insufficient-credits'; // 402 + code=insufficient_credits → quota_exhausted
    try {
      const aId = await addChannel({ name: 'asf-402', baseUrl: a.url, priority: 10 });
      const bId = await addChannel({ name: 'asf-402-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');
      const t0 = Date.now();

      // 流式请求：A 欠费（首字节前失败）→ 换 B 服务——客户端只见 B 的 200 SSE
      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e stream failover 402' }],
      });
      expect(res.status).toBe(200); // 换渠发生在响应头发出前——无协议错乱
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const text = await res.text();
      expectCleanRelayStream(text);

      // A 只收到过一次流式请求（quota_exhausted 不可同渠道重试）
      expect(a.recorded).toHaveLength(1);
      expect((defined(a.recorded[0], 'A recorded').body as { stream?: boolean }).stream).toBe(true);
      // B 服务了流式请求
      expect(b.recorded).toHaveLength(1);
      expect((defined(b.recorded[0], 'B recorded').body as { stream?: boolean }).stream).toBe(true);

      // A 进 quota 惩罚箱（fire-and-forget 记账——有界等待）：30 分钟档（quotaMs=1_800_000）
      const penalty = await waitFor('quota penalty', () =>
        healthKeyOf(gateway, `penalty:ch:${aId}`),
      );
      expect(penalty.kind).toBe('quota_exhausted');
      expect(Number(penalty.until)).toBeGreaterThan(t0 + 25 * 60_000); // 30min 档而非 429 的 2s 档
      expect(Number(penalty.consecutive)).toBeGreaterThanOrEqual(1);

      // 结算与对账（usage 证据细节在场景⑤单独断言）
      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
      // 换渠即释放旧渠道敞口、结算后释放新渠道敞口——两侧归零（无预留泄漏）
      //（numeric(38,18) 文本形如 '0.000000000000000000'——Decimal 比较而非字符串等值）
      await waitFor(`reserved a=${aId} → 0`, async () =>
        new Decimal(await reservedOf(aId)).isZero(),
      );
      await waitFor(`reserved b=${bId} → 0`, async () =>
        new Decimal(await reservedOf(bId)).isZero(),
      );

      // 分类一致性（流式与非流式共用 adapter.mapError + statusKind 词表）：
      // 独立渠道对复刻非流式 402 → 同样换渠成功
      const c = startMockUpstream();
      const d = startMockUpstream();
      await c.ready;
      await d.ready;
      c.script = 'insufficient-credits';
      try {
        await addChannel({ name: 'asf-402-plain', baseUrl: c.url, priority: 10 });
        await addChannel({ name: 'asf-402-plain-backup', baseUrl: d.url, priority: 5 });
        const plain = await e2ePost(gateway.baseUrl, key.raw, {
          model: E2E_MODEL,
          max_tokens: 300,
          messages: [{ role: 'user', content: 'e2e nonstream 402 parity' }],
        });
        expect(plain.status).toBe(200);
        await expect(plain.json()).resolves.toMatchObject({
          choices: [{ message: { role: 'assistant' } }],
        });
        // 402 打在非流式路径（c 收到无 stream 标记的请求）；服务方在 p5 层加权随机
        // 落 b 或 d（同层并列）——合计恰两次服务（流式一次 + 非流式一次）
        expect(c.recorded).toHaveLength(1);
        expect((defined(c.recorded[0], 'C recorded').body as { stream?: boolean }).stream).not.toBe(
          true,
        );
        expect(b.recorded.length + d.recorded.length).toBe(2);
      } finally {
        await c.close();
        await d.close();
      }
      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it('② 流式首字节前 503：同渠道重试 3 次后换渠成功；熔断计数记账', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.script = 'server-error'; // 503 → upstream_error（retryable=true → 同渠道重试）
    try {
      const aId = await addChannel({ name: 'asf-503', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'asf-503-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e stream failover 503' }],
      });
      expect(res.status).toBe(200);
      expectCleanRelayStream(await res.text());

      // upstream_error 可重试：maxAttempts=3（含首次）→ A 恰收 3 次流式请求后让位
      expect(a.recorded).toHaveLength(3);
      for (const rec of a.recorded) {
        expect((rec.body as { stream?: boolean }).stream).toBe(true);
      }
      expect(b.recorded).toHaveLength(1);

      // 503 走熔断计数（circuitTrip=true；阈值 5 未到 → closed 但已有失败事实）
      const breakerKey = `breaker:openai-compatible://${new URL(a.url).host}`;
      const breaker = await waitFor('breaker record', () => healthKeyOf(gateway, breakerKey));
      expect(breaker.state).toBe('closed');
      expect((breaker.failures as number[]).length).toBeGreaterThanOrEqual(1);
      // 503 不进惩罚箱（惩罚箱只收 429/quota——键不存在）
      expect(await healthKeyOf(gateway, `penalty:ch:${aId}`)).toBeNull();

      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it('③ 首字节后上游挂住 + 客户端断连：取消传播到上游连接、预留释放、可信 usage 照实结算', async () => {
    // 首帧立即 + 每 400ms 一帧：客户端读首批帧后 abort → 只有首帧被消费（确定性）
    const hold = startHoldUpstream(400);
    await hold.ready;
    try {
      const aId = await addChannel({ name: 'asf-hold', baseUrl: hold.url, priority: 10 });
      const key = await keys.issue('10');
      const ac = new AbortController();

      const res = await e2ePost(
        gateway.baseUrl,
        key.raw,
        {
          model: E2E_MODEL,
          stream: true,
          max_tokens: 300,
          messages: [{ role: 'user', content: 'e2e stream cancel' }],
        },
        ac.signal,
      );
      expect(res.status).toBe(200);
      const reader = defined(res.body, 'stream body').getReader();
      const first = await reader.read(); // 首批帧已到（首字节后窗口——不再换渠）
      expect(defined(first.value, 'first chunk').byteLength).toBeGreaterThan(0);
      ac.abort(); // 客户端断连
      await reader.cancel().catch(() => {});

      // 网关侧取消传播：上游挂住连接被释放（未收尾即关闭——有界等待）
      await waitFor('upstream connection released', async () => hold.closed >= 1);
      expect(hold.recorded).toBe(1);

      // 结算：取消但增量帧携带可信累计 usage → 正常结算（stream_aborted=false、不估算）
      await awaitSettled(key.userId);
      const rows = await usageRowsOf(key.userId);
      expect(rows).toHaveLength(1);
      const row = defined(rows[0], 'usage row');
      expect(row.channel_id).toBe(String(aId)); // 归属=实际服务的挂住渠道
      expect(row.input_tokens).toBe('50');
      expect(row.stream).toBe(true);
      expect(row.stream_aborted).toBe(false);
      expect(row.estimated).toBe(false);
      // 输出 = 已消费帧数 × 5（abort 传播时窗内只有首帧——放宽到 [5,50] 防帧边界抖动）
      const output = Number(row.output_tokens);
      expect(output).toBeGreaterThanOrEqual(5);
      expect(output).toBeLessThanOrEqual(50);
      expect(output % 5).toBe(0);
      // 金额与 token 自洽：(50×2.1 + output×8.4)/1e6
      const expected = new Decimal(50)
        .times('2.1')
        .plus(new Decimal(output).times('8.4'))
        .div(1_000_000)
        .toString();
      expect(new Decimal(row.amount).eq(expected)).toBe(true);

      // 渠道进货额度预留最终释放（结算完成 → tryDecreaseReserved）——无泄漏
      await waitFor(`reserved a=${aId} → 0`, async () =>
        new Decimal(await reservedOf(aId)).isZero(),
      );
      await keys.assertReconciled(key.userId, '10'); // 在途归零（钱包侧无悬挂预扣）
    } finally {
      await hold.close();
    }
  }, 60_000);

  it('④ 慢首字节 + 换渠交互：connectMs 超时（kind=timeout）→ 同渠道重试 3 次后换渠，B 单源服务', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.delayMs = 3_000; // 响应头 3s > 紧 connect 网关 1.5s → fetch 层 timeout（可换渠类）
    try {
      await addChannel({ name: 'asf-slow', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'asf-slow-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');
      const t0 = Date.now();

      const res = await e2ePost(tightConnectGw.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e slow first byte' }],
      });
      const elapsed = Date.now() - t0;
      expect(res.status).toBe(200);
      expectCleanRelayStream(await res.text());

      // timeout 可重试：A 同渠道 3 次尝试（3×1.5s + 退避）后才换渠；B 快速接手
      expect(a.recorded).toHaveLength(3);
      expect(b.recorded).toHaveLength(1);
      // 3 次超时尝试 + 退避的时间下界（< 3×1.5s 说明没等满同渠道预算就放弃了）
      expect(elapsed).toBeGreaterThanOrEqual(4_000);
      console.log(`④ 慢首字节换渠耗时 ${elapsed}ms（3×connectMs 超时 + 退避 + B 服务）`);

      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 90_000);

  it('④b 回归：deadline（GATEWAY_UPSTREAM_DEADLINE_MS）中止的慢首字节渠道→换渠 200（已修复）', async () => {
    // 与④对照：同样的慢渠道，预算由 withRetry 的 deadline 中止。原缺陷：外部信号中止
    // 一律归 kind=canceled（与客户端取消混用）→ next_candidate break 渠道循环，健康备用
    // 零咨询 + 死记忆连坐。修复：abort reason 携带 RetryDeadlineAbort 标记，传输层归类
    // timeout（可换渠 + 熔断计数）——慢上游让位给备用渠道。
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.delayMs = 3_000; // > 紧 deadline 网关 2s（connectMs 缺省 10s 不会先触发）
    try {
      await addChannel({ name: 'asf-deadline', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'asf-deadline-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      const res = await e2ePost(tightDeadlineGw.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e deadline abort failover' }],
      });
      // 修复后行为：timeout 归类（可换渠）→ B 接手 → 客户端 200 收到 B 的完整流
      expect(res.status).toBe(200);
      await res.text().catch(() => {});
      expect(a.recorded).toHaveLength(1); // deadline 中止当次尝试（timeout 不可在同渠道重试）
      expect(b.recorded).toHaveLength(1); // 备用渠道被咨询并服务
      console.log(`④b deadline 中止慢渠道换渠：status=${res.status}，B 咨询=1`);

      // 结算收口：正常计费（B 服务）、无滞留
      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it('⑤ 流式 usage 证据与渠道归属：换渠后 usage_logs 记 B 渠道、token 取自 B 的 usage 帧、金额按公式', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.script = 'server-error'; // 任意首字节前失败向量——换渠后由 B 服务
    try {
      const aId = await addChannel({ name: 'asf-attr', baseUrl: a.url, priority: 10 });
      const bId = await addChannel({ name: 'asf-attr-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e attribution' }],
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      // 客户端可见的最终 usage 帧来自 B 的脚本（completion=100）
      const completions = sseFrames(text)
        .map(usageCompletionOf)
        .filter((v): v is number => v !== undefined);
      expect(defined(completions.at(-1), 'final usage frame')).toBe(100);

      await awaitSettled(key.userId);
      const rows = await usageRowsOf(key.userId);
      expect(rows).toHaveLength(1);
      const row = defined(rows[0], 'usage row');
      expect(row.channel_id).toBe(String(bId)); // 归属=实际服务的 B（失败尝试的 A 不留账）
      expect(row.channel_id).not.toBe(String(aId));
      expect(row.input_tokens).toBe('50'); // B 的 usage 帧 prompt_tokens
      expect(row.output_tokens).toBe('100'); // B 的终帧 usage completion_tokens
      expect(row.estimated).toBe(false);
      // 金额按 B 的 token 与映射价计算：(50×2.1 + 100×8.4)/1e6 = 0.000945
      //（numeric(38,18) 落库带尾零——Decimal 等值比较）
      expect(new Decimal(row.amount).eq('0.000945')).toBe(true);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);

  it('⑥ 同渠道流式重试边界：429（无 Retry-After）同渠道最多 3 次调用后换渠，最终 200', async () => {
    const a = startMockUpstream();
    const b = startMockUpstream();
    await a.ready;
    await b.ready;
    a.script = 'rate-limit';
    a.rateLimitRetryAfterSec = 0; // 不发 Retry-After：重试间隔只剩指数退避（免 3s×2 等待）
    try {
      const aId = await addChannel({ name: 'asf-429', baseUrl: a.url, priority: 10 });
      await addChannel({ name: 'asf-429-backup', baseUrl: b.url, priority: 5 });
      const key = await keys.issue('10');
      const t0 = Date.now();

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        stream: true,
        max_tokens: 300,
        messages: [{ role: 'user', content: 'e2e same-channel retry budget' }],
      });
      expect(res.status).toBe(200);
      expectCleanRelayStream(await res.text());

      // withRetry 语义：maxAttempts 含首次调用（sameChannelMaxRetries=3 → ≤3 次上游
      // 调用；不是 3 次重试=4 次调用）。429 可重试 → A 恰好打满预算 3 次。
      expect(a.recorded).toHaveLength(3);
      expect(b.recorded).toHaveLength(1);

      // 429 记惩罚箱（rate_limited；无 Retry-After → 冷却=base 2000ms 档）
      const penalty = await waitFor('rate penalty', () =>
        healthKeyOf(gateway, `penalty:ch:${aId}`),
      );
      expect(penalty.kind).toBe('rate_limited');
      expect(Number(penalty.until)).toBeGreaterThan(t0);
      expect(Number(penalty.consecutive)).toBeGreaterThanOrEqual(1);

      await awaitSettled(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await a.close();
      await b.close();
    }
  }, 60_000);
});
