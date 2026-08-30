/**
 * E2E 智能路由「故障切换矩阵 + 跨请求记忆」：
 *   ① 402 欠费换渠：当请求换渠 + 30min 惩罚箱（Redis 键事实）+ 第二请求零重复撞击
 *   ② 402 惩罚时长策略一致性：routing_policies 热切 quotaMs 10s → 惩罚到期后渠道恢复参与
 *   ③ 503 换渠 + host 熔断：连续失败达阈值 open → A 零调用直达 B
 *   ④ 熔断半开恢复：冷却到期后放行单探测，上游恢复则回 closed
 *   ⑤ 换渠计费预留转移：billing_requests.channel_id 归属服务渠道，旧渠敞口释放、
 *      失败尝试不产生 usage_logs
 *   ⑥ Retry-After 权威性：429 的 Retry-After=3s 是惩罚冷却权威下界
 *   ⑦ 全败终局分类码：单渠道 402/503 全败 → billing_requests.failure_code 记
 *      quota_exhausted / upstream_error（statusKind 分类的落账终点）
 *
 * 契约事实（源码核实，勿猜）：
 *   - 惩罚键 inference:health:penalty:ch:{channelId}，值 {kind,until,consecutive,version}
 *     （packages/inference/src/health/penalty.ts）；quota_exhausted 冷却 = quotaMs
 *     （缺省 1_800_000ms，schema 下限 10_000）；rate_limited 冷却 =
 *     max(base×2^(n-1), Retry-After)，base 缺省 2_000。
 *   - 熔断键 inference:health:breaker:{protocol}://{host}（缺省 window 60s / 阈值 5 /
 *     cooldown 300s / halfOpenProbe=true；gateway 装配不覆写——assembly.ts defaults 无
 *     breaker 段）；TTL = cooldown+window（breaker.ts casBreaker）。
 *   - 402 → quota_exhausted（packages/ai/src/errors/fallback.ts statusKind），
 *     retryable=false / circuitTrip=false；503 → upstream_error，retryable=circuitTrip=true。
 *   - 换渠预留转移：reserveChannel switch 模式先预留新渠→释放旧渠→CAS 认领
 *     （packages/billing/src/application/billing/reserve-channel.ts）；结算归还敞口
 *     + usage_logs 投影（application/settlement/settle.ts）；request.failed →
 *     released + failure_code=reason（application/billing/signal.ts）。
 *   - 策略热源：routing_policies(scope='global') TTL 拾取（缺省 15s，
 *     ROUTING_POLICY_TTL_MS 可调小）——apps/gateway/src/adapters/routing-policy.ts。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_MODEL,
  E2E_REAL_MODEL,
  defined,
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
let gateway: E2EGateway;
let keys: E2EKeys;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

/** 在世界目录追加渠道 + 绑定 E2E_MODEL（priority 决定调度序：主渠道在前） */
async function addChannel(input: {
  name: string;
  baseUrl: string;
  apiKeyPlain?: string;
  priority: number;
  budget?: string;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(input.apiKeyPlain ?? E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, 1, ${input.budget ?? '1000'})
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${world.seed.mappingId}, ${id}, ${E2E_REAL_MODEL})`);
  return id;
}

/** Redis 健康键原始值（惩罚/熔断状态机 JSON） */
async function healthKeyOf(gw: E2EGateway, key: string): Promise<unknown> {
  const raw = await gw.assembly.redis.get(`inference:health:${key}`);
  return raw == null ? null : JSON.parse(raw);
}

/** 惩罚键快照（kind/until/consecutive + 剩余毫秒与 pttl——TTL 与策略一致性证据） */
async function penaltySnapshot(
  gw: E2EGateway,
  channelId: number,
): Promise<{
  kind?: string;
  until?: number;
  consecutive?: number;
  remainingMs: number;
  ttlMs: number;
}> {
  const raw = await gw.assembly.redis.get(`inference:health:penalty:ch:${channelId}`);
  if (raw == null) return { remainingMs: 0, ttlMs: -1 };
  const state = JSON.parse(raw) as {
    kind?: string;
    until?: number;
    consecutive?: number;
  };
  const pttl = await gw.assembly.redis.pttl(`inference:health:penalty:ch:${channelId}`);
  return {
    kind: state.kind,
    until: state.until,
    consecutive: state.consecutive,
    remainingMs: Math.max(0, (state.until ?? 0) - Date.now()),
    ttlMs: pttl,
  };
}

/** host 熔断键（protocol 固定 openai-compatible——kit 种子 provider 协议） */
function breakerKeyOf(url: string): string {
  return `breaker:openai-compatible://${new URL(url).host}`;
}

/** 渠道在途敞口（numeric(38,18)——数值口径比较，字符串形态是 18 位小数零） */
async function channelReservedOf(channelId: number): Promise<number> {
  const rows = await world.db.execute<{ reserved: string | null }>(sql`
    select upstream_reserved::text as reserved from channels where id = ${channelId}`);
  return Number(rows[0]?.reserved ?? '0');
}

/** routing_policies 全局行写入（管理台保存等价；jsonb 绑参需显式 ::jsonb）。
 * 本套件场景全部要求智能路由开启——单渠道直连规格见 single-track.test */
async function writeRoutingPolicy(policy: Record<string, unknown>): Promise<void> {
  const doc = JSON.stringify({ enabled: true, ...policy });
  await world.db.execute(
    sql`insert into routing_policies (scope, version, policy)
       values ('global', '1', ${doc}::jsonb)
       on conflict (scope) do update set policy = ${doc}::jsonb, updated_at = now()`,
  );
}

/** 完整合法策略形状（zod schema 全段——坏形状会被解析拒绝沿用旧值） */
const fullPolicy = (patch: {
  retry?: { sameChannelMaxRetries: number };
  penalty?: {
    rateLimitBaseMs: number;
    rateLimitMaxMs: number;
    quotaMs: number;
  };
}): Record<string, unknown> => ({
  scorers: {
    cacheAffinity: {
      enabled: false,
      boost: 3,
      ttlMs: 300_000,
      prefixChars: 4_096,
    },
    budgetWatermark: { enabled: true, softRatio: 0.2 },
  },
  retry: patch.retry ?? { sameChannelMaxRetries: 3 },
  penalty: patch.penalty ?? {
    rateLimitBaseMs: 2_000,
    rateLimitMaxMs: 60_000,
    quotaMs: 1_800_000,
    conditionalBypass: true,
  },
  modelDead: { failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 },
  wait: { enabled: false, maxWaitMs: 100 },
});

/** 起 1s TTL 策略网关（策略热切换观测形态）+ Redis 就绪屏障 */
async function startShortTtlGateway(): Promise<E2EGateway> {
  const gw = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
  for (let i = 0; i < 50; i += 1) {
    if ((await gw.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await sleep(100);
  }
  await sleep(500); // 限流闸连接就绪余量
  return gw;
}

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await sleep(100);
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
  // 种子渠道解绑（场景拓扑自管渠道集）
  await world.db.execute(
    sql`delete from model_channels where channel_id = ${world.seed.channelId}`,
  );
});

afterAll(async () => {
  await gateway.stop();
  await world.teardown();
});

beforeEach(async () => {
  await resetChannelHealth(gateway);
  await world.db.execute(
    sql`delete from model_channels where mapping_id = ${world.seed.mappingId}`,
  );
});

describe.skipIf(!hasEnv)('E2E 故障切换矩阵：402/503/429 × 惩罚箱/熔断/计费', () => {
  it('① 402 欠费换渠：换渠成功 + 30 分钟惩罚箱 + 第二请求零重复撞击', async () => {
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'insufficient-credits';
      const chA = await addChannel({
        name: 'fm-quota-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      await addChannel({
        name: 'fm-quota-b',
        baseUrl: mockB.url,
        priority: 5,
      });
      const key = await keys.issue('10');
      const chat = () =>
        e2ePost(gateway.baseUrl, key.raw, {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'fm 402 failover' }],
        });

      // 请求 1：A 402（quota_exhausted 不可重试——恰好一次上游调用）→ 换 B 成功
      const res1 = await chat();
      expect(res1.status).toBe(200);
      expect(mockA.recorded.length).toBe(1);
      expect(mockB.recorded.length).toBe(1);

      // 惩罚箱记账落地（fire-and-forget）：402 → quota_exhausted + 30min 冷却
      await sleep(300);
      const penalty = await penaltySnapshot(gateway, chA);
      expect(penalty.kind).toBe('quota_exhausted');
      expect(penalty.consecutive).toBeGreaterThanOrEqual(1);
      expect(penalty.remainingMs).toBeGreaterThan(29 * 60_000); // 缺省 quotaMs=1_800_000
      // 键 TTL 与策略一致：recordPenalty 落 TTL = delayMs + 1s（penalty.ts CAS）
      expect(penalty.ttlMs).toBeGreaterThan(29 * 60_000);
      expect(penalty.ttlMs).toBeLessThanOrEqual(1_800_000 + 1_000 + 2_000);

      // 请求 2（冷却期内）：conditionalBypass 条件门——B 未惩罚 → A 被跳过，零重复撞击
      const res2 = await chat();
      expect(res2.status).toBe(200);
      expect(mockA.recorded.length).toBe(1);
      expect(mockB.recorded.length).toBe(2);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
      await mockB.close();
    }
  }, 60_000);

  it('③ 503 换渠 + host 熔断：连续失败 open 后 A 零调用直达 B', async () => {
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'server-error';
      await addChannel({
        name: 'fm-503-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      await addChannel({ name: 'fm-503-b', baseUrl: mockB.url, priority: 5 });
      const key = await keys.issue('10');
      const chat = () =>
        e2ePost(gateway.baseUrl, key.raw, {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'fm 503 breaker' }],
        });

      // 请求 1：A 503（upstream_error，同渠道重试耗尽后）→ 换 B 成功
      const res1 = await chat();
      expect(res1.status).toBe(200);
      expect(mockA.recorded.length).toBeGreaterThanOrEqual(1);
      expect(mockB.recorded.length).toBe(1);

      // 连续请求累计熔断失败（阈值 5 / 窗口 60s）：发到 breaker open 为止
      let open = false;
      for (let i = 0; i < 6 && !open; i++) {
        const res = await chat();
        expect(res.status).toBe(200);
        await sleep(300); // fire-and-forget 记账落地
        const breaker = (await healthKeyOf(gateway, breakerKeyOf(mockA.url))) as {
          state?: string;
        } | null;
        open = breaker?.state === 'open';
      }
      expect(open).toBe(true); // 7 个请求 × ≥1 circuitTrip 失败必超阈值 5

      // open 后：A 在门前被拒（circuit_open），零上游调用直达 B
      const aCalls = mockA.recorded.length;
      const bCalls = mockB.recorded.length;
      const res = await chat();
      expect(res.status).toBe(200);
      expect(mockA.recorded.length).toBe(aCalls); // 零重复撞击（熔断跨请求记忆）
      expect(mockB.recorded.length).toBe(bCalls + 1);

      // 键 TTL 与熔断配置一致：cooldown(300s) + window(60s)——breaker.ts casBreaker
      const ttl = await gateway.assembly.redis.pttl(`inference:health:${breakerKeyOf(mockA.url)}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300_000 + 60_000);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
      await mockB.close();
    }
  }, 120_000);

  it('④ 熔断半开恢复：冷却到期放行单探测，上游恢复后回 closed', async () => {
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'server-error';
      await addChannel({
        name: 'fm-halfopen-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      await addChannel({
        name: 'fm-halfopen-b',
        baseUrl: mockB.url,
        priority: 5,
      });
      const key = await keys.issue('10');
      const chat = () =>
        e2ePost(gateway.baseUrl, key.raw, {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'fm half-open recovery' }],
        });

      // 打开熔断（缺省 cooldown 300s——e2e 不等 5 分钟，用 Redis 状态改写模拟冷却到期）
      let open = false;
      for (let i = 0; i < 7 && !open; i++) {
        const res = await chat();
        expect(res.status).toBe(200);
        await sleep(300);
        const breaker = (await healthKeyOf(gateway, breakerKeyOf(mockA.url))) as {
          state?: string;
        } | null;
        open = breaker?.state === 'open';
      }
      expect(open).toBe(true);

      // 上游恢复
      mockA.script = 'auto';
      const aCalls = mockA.recorded.length;

      // 冷却到期等价改写：cooldownUntil 置于过去（保持 state/version——CAS 语义不受破坏）
      const breakerKey = `inference:health:${breakerKeyOf(mockA.url)}`;
      const raw = defined(
        await gateway.assembly.redis.get(breakerKey),
        'breaker state before probe',
      );
      const state = JSON.parse(raw) as {
        state: string;
        version: number;
        cooldownUntil?: number;
      };
      state.cooldownUntil = Date.now() - 2_000;
      const ttl = await gateway.assembly.redis.pttl(breakerKey);
      await gateway.assembly.redis.set(
        breakerKey,
        JSON.stringify(state),
        'PX',
        Math.max(ttl, 60_000),
      );

      // 下一请求：half-open 放行单探测到 A（而非直拒/直达 B）
      const res = await chat();
      expect(res.status).toBe(200);
      expect(mockA.recorded.length).toBe(aCalls + 1); // 探测落 A

      // 探测成功 → CAS 恢复 closed（fire-and-forget 落地等待）
      await sleep(300);
      const after = (await healthKeyOf(gateway, breakerKeyOf(mockA.url))) as {
        state?: string;
      } | null;
      expect(after?.state).toBe('closed');

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
      await mockB.close();
    }
  }, 120_000);

  it('⑤ 换渠计费预留转移：billing_requests 归属服务渠 B，A 敞口释放，失败尝试零 usage', async () => {
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'insufficient-credits';
      const chA = await addChannel({
        name: 'fm-bill-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      const chB = await addChannel({
        name: 'fm-bill-b',
        baseUrl: mockB.url,
        priority: 5,
      });
      const key = await keys.issue('10');

      // 请求：A 402 → 换 B 成功（B 服务）
      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'fm reservation transfer' }],
      });
      expect(res.status).toBe(200);
      expect(mockA.recorded.length).toBe(1);
      expect(mockB.recorded.length).toBe(1);

      // 结算前（e2e 无 worker——settlement_pending 稳定）：
      // 账单行认领 B（换渠 CAS 终点），A 敞口已在换渠事务释放、B 在途
      const bills = await keys.billsOf(key.userId);
      expect(bills).toHaveLength(1);
      const billRows = await world.db.execute<{
        channel_id: number | null;
        reserved: string | null;
      }>(sql`select channel_id, channel_reserved_amount::text as reserved
             from billing_requests where user_id = ${key.userId}`);
      expect(billRows[0]?.channel_id != null && Number(billRows[0].channel_id)).toBe(chB);
      expect(Number(billRows[0]?.reserved ?? '0')).toBeGreaterThan(0);
      expect(bills[0]?.status).toBe('settlement_pending');
      expect(await channelReservedOf(chA)).toBe(0); // 换渠释放（switch 先守卫新渠再释放旧渠）
      expect(await channelReservedOf(chB)).toBeGreaterThan(0); // 在途敞口

      // 失败尝试（A 的 402）不产生 usage_logs——失败不计费
      const usageBefore = await world.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_logs where user_id = ${key.userId}`,
      );
      expect(defined(usageBefore[0], 'usage count before settle').n).toBe(0);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');

      // 结算后：B 敞口归还（settle.ts tryDecreaseReserved）——无泄漏
      expect(await channelReservedOf(chB)).toBe(0);
      expect(await channelReservedOf(chA)).toBe(0);
      const finalRows = await world.db.execute<{ status: string }>(
        sql`select status from billing_requests where user_id = ${key.userId}`,
      );
      expect(finalRows[0]?.status).toBe('settled');

      // usage_logs 恰一行且归属 B（服务渠道）——A 的失败尝试无计量行
      const usage = await world.db.execute<{
        n: number;
        channel_id: string | null;
      }>(
        sql`select count(*)::int as n, max(channel_id)::text as channel_id from usage_logs where user_id = ${key.userId}`,
      );
      expect(defined(usage[0], 'usage after settle').n).toBe(1);
      expect(usage[0]?.channel_id != null && Number(usage[0].channel_id)).toBe(chB);
    } finally {
      await mockA.close();
      await mockB.close();
    }
  }, 60_000);

  it('⑦a 全败终局分类：单渠道 402 → 503 no_available_channel + failure_code=quota_exhausted + released 不计费', async () => {
    const mockA = startMockUpstream();
    await mockA.ready;
    try {
      mockA.script = 'insufficient-credits';
      await addChannel({
        name: 'fm-solo-402',
        baseUrl: mockA.url,
        priority: 10,
      });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'fm solo 402 terminal' }],
      });
      // quota_exhausted 归渠道面竭尽（isChannelExhausted 词表）→ 503 no_available_channel：
      // 欠费是「该充值/换供应商」的运营语义，不得误导向上游故障 502
      expect(res.status).toBe(503);

      const rows = await world.db.execute<{
        status: string;
        failure_code: string | null;
      }>(sql`select status, failure_code from billing_requests where user_id = ${key.userId}`);
      expect(rows[0]?.status).toBe('released'); // 三路预扣释放（不扣费）
      expect(rows[0]?.failure_code).toBe('quota_exhausted'); // statusKind 402 分类的落账终点

      const usage = await world.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_logs where user_id = ${key.userId}`,
      );
      expect(defined(usage[0], 'usage count').n).toBe(0);
      await keys.assertReconciled(key.userId, '10'); // 分文未动
    } finally {
      await mockA.close();
    }
  }, 60_000);

  it('⑦b 全败终局分类：单渠道 503 → failure_code=upstream_error + released', async () => {
    const mockA = startMockUpstream();
    await mockA.ready;
    try {
      mockA.script = 'server-error';
      await addChannel({
        name: 'fm-solo-503',
        baseUrl: mockA.url,
        priority: 10,
      });
      const key = await keys.issue('10');

      const res = await e2ePost(gateway.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'fm solo 503 terminal' }],
      });
      expect(res.status).toBe(502); // upstream_error 可换渠无渠可换 → upstream_failed

      const rows = await world.db.execute<{
        status: string;
        failure_code: string | null;
      }>(sql`select status, failure_code from billing_requests where user_id = ${key.userId}`);
      expect(rows[0]?.status).toBe('released');
      expect(rows[0]?.failure_code).toBe('upstream_error');

      const usage = await world.db.execute<{ n: number }>(
        sql`select count(*)::int as n from usage_logs where user_id = ${key.userId}`,
      );
      expect(defined(usage[0], 'usage count').n).toBe(0);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
    }
  }, 60_000);
});

/** 策略热切换族：独立 1s TTL 网关（写表 → TTL 拾取 → 参数生效） */
describe.skipIf(!hasEnv)('E2E 故障矩阵：策略热切换观测', () => {
  it('② 402 惩罚时长策略一致性：quotaMs 热切 30min→10s，到期后 A 恢复参与路由', async () => {
    // 先写小 quota 策略（schema 下限 10s）再起网关——首启即拾取，免 TTL 等待
    await writeRoutingPolicy(
      fullPolicy({
        penalty: {
          rateLimitBaseMs: 2_000,
          rateLimitMaxMs: 60_000,
          quotaMs: 10_000,
        },
      }),
    );
    const gw = await startShortTtlGateway();
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'insufficient-credits';
      const chA = await addChannel({
        name: 'fm-hotquota-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      await addChannel({
        name: 'fm-hotquota-b',
        baseUrl: mockB.url,
        priority: 5,
      });
      const key = await keys.issue('10');
      const chat = () =>
        e2ePost(gw.baseUrl, key.raw, {
          model: E2E_MODEL,
          messages: [{ role: 'user', content: 'fm hot quota' }],
        });

      // 请求 1：A 402 → 换 B 成功；惩罚冷却 = 热策略 quotaMs 10s（缺省 30min 会 >1_700_000）
      const res1 = await chat();
      expect(res1.status).toBe(200);
      await sleep(300);
      const penalty = await penaltySnapshot(gw, chA);
      expect(penalty.kind).toBe('quota_exhausted');
      expect(penalty.remainingMs).toBeGreaterThan(8_000);
      expect(penalty.remainingMs).toBeLessThanOrEqual(10_000);
      // 键 TTL = quotaMs + 1s（recordPenalty CAS ttl 参数）——与策略一致
      expect(penalty.ttlMs).toBeGreaterThan(0);
      expect(penalty.ttlMs).toBeLessThanOrEqual(10_000 + 1_000 + 1_000);

      // 请求 2（冷却期内）：A 零调用
      const res2 = await chat();
      expect(res2.status).toBe(200);
      const aHits = mockA.recorded.length;
      expect(aHits).toBe(1);

      // 等冷却过期（10s + 余量）
      await sleep(10_800);

      // 请求 3：A 恢复参与——再撞一次 402（仍换 B 成功）
      const res3 = await chat();
      expect(res3.status).toBe(200);
      expect(mockA.recorded.length).toBe(aHits + 1);
      expect(mockB.recorded.length).toBe(3);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
      await mockB.close();
      await gw.stop();
    }
  }, 60_000);

  it('⑥ Retry-After 权威性：429+Retry-After=3s → 惩罚冷却下界 3s（超过 base 2s）', async () => {
    // sameChannelMaxRetries=1：A 恰撞一次 429 即换渠——记账时刻即请求内首次失败，
    // until = at + max(base 2000, retryAfter 3000) = at + 3000（权威下界证据）
    await writeRoutingPolicy(fullPolicy({ retry: { sameChannelMaxRetries: 1 } }));
    const gw = await startShortTtlGateway();
    const mockA = startMockUpstream();
    const mockB = startMockUpstream();
    await mockA.ready;
    await mockB.ready;
    try {
      mockA.script = 'rate-limit';
      mockA.rateLimitRetryAfterSec = 3;
      const chA = await addChannel({
        name: 'fm-ra-a',
        baseUrl: mockA.url,
        priority: 10,
      });
      await addChannel({ name: 'fm-ra-b', baseUrl: mockB.url, priority: 5 });
      const key = await keys.issue('10');

      const t0 = Date.now();
      const res = await e2ePost(gw.baseUrl, key.raw, {
        model: E2E_MODEL,
        messages: [{ role: 'user', content: 'fm retry-after authority' }],
      });
      expect(res.status).toBe(200); // 换渠成功
      expect(mockA.recorded.length).toBe(1); // 无同渠道重试（预算 1）

      await sleep(300);
      const penalty = await penaltySnapshot(gw, chA);
      expect(penalty.kind).toBe('rate_limited');
      expect(penalty.consecutive).toBe(1);
      // 绝对时刻断言（不依赖读值耗时）：until ≥ t0+3000——若 Retry-After 丢失，
      // 冷却 = base 2000 → until < t0+3000，区分度 1000ms
      expect(defined(penalty.until, 'penalty until')).toBeGreaterThanOrEqual(t0 + 3_000);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await mockA.close();
      await mockB.close();
      await gw.stop();
    }
  }, 60_000);
});
