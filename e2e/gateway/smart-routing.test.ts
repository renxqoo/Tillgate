/**
 * E2E 智能渠道路由（阶段一：跨请求记忆 + 调度信号）：
 *   ① 正常路由：多渠道 priority 调度 + 先结算后交付 + 对账
 *   ② 429 → 当请求换渠 + 惩罚箱跨请求冷却（第二请求起零重复撞击）+ Redis 键事实
 *   ③ 死凭据按 channel 维：坏 Key 渠道连续 3 次后整体跳过（换渠不受影响）
 *   ④ 上游挂（网络拒连）→ 换渠成功 + host 熔断 open（Redis 键事实）
 *   ⑤ 渠道预算硬闸：敞口 > 余额的渠道在门前被拒（零上游调用直达备用）
 * 全真装配网关（真 PG/Redis/billing/inference）+ 真实用户 key（E2EKeys 台账）。
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
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';
import { E2E_UPSTREAM_KEY, startMockUpstream, type MockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

let world: E2EWorld;
let gateway: E2EGateway;
let keys: E2EKeys;
/** 辅助 mock 实例（429 脚本 / 死上游）——每实例独立 recorded 分桶 */
let bad429: MockUpstream;
let deadUpstream: MockUpstream;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

/** 在世界目录追加渠道 + 绑定到 E2E_MODEL（priority 决定次序：主渠道在前；
 *  upstreamModel 缺省 = 规范名——异名旅程显式传厂商拼写） */
async function addChannel(input: {
  name: string;
  baseUrl: string;
  apiKeyPlain: string;
  priority: number;
  budget?: string;
  upstreamModel?: string;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(input.apiKeyPlain)},
            ${input.baseUrl}, ${input.priority}, 1, ${input.budget ?? '1000'})
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${world.seed.mappingId}, ${id}, ${input.upstreamModel ?? E2E_REAL_MODEL})`);
  return id;
}

/** 渠道门重排前的既有渠道（种子渠道）——解绑以免干扰场景拓扑 */
async function unbindSeedChannel(): Promise<void> {
  await world.db.execute(
    sql`delete from model_channels where channel_id = ${world.seed.channelId}`,
  );
}

/** Redis 健康键原始值（熔断/惩罚箱状态机 JSON） */
async function healthKeyOf(key: string): Promise<unknown> {
  const raw = await gateway.assembly.redis.get(`inference:health:${key}`);
  return raw == null ? null : JSON.parse(raw);
}

const chat = (raw: string) =>
  e2ePost(gateway.baseUrl, raw, {
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'e2e smart routing' }],
  });

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  // kit 的就绪防线只覆盖鉴权链——限流闸 fail-closed，Redis 握手完成前请求会 400。
  // 显式等待收敛残余竞速窗口。
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
  bad429 = startMockUpstream();
  await bad429.ready;
  bad429.script = 'rate-limit';
  deadUpstream = startMockUpstream();
  await deadUpstream.ready;
  await deadUpstream.close(); // 端口即拒连——网络故障形态
  await unbindSeedChannel();
});

afterAll(async () => {
  await bad429.close();
  await gateway.stop();
  await world.teardown();
});

beforeEach(async () => {
  await resetChannelHealth(gateway);
  // 场景隔离：解绑上一场景追加的渠道（渠道行保留无害——未绑定不参与路由）
  await world.db.execute(
    sql`delete from model_channels where mapping_id = ${world.seed.mappingId}`,
  );
});

describe.skipIf(!hasEnv)('E2E 智能渠道路由', () => {
  it('① 正常路由：priority 分层直达主渠道，先结算后交付，对账平衡', async () => {
    // 主/备独立 mock 实例——录制分桶可断言「p10 主渠道先于 p5 备用被调」
    const mainMock = startMockUpstream();
    await mainMock.ready;
    try {
      await addChannel({
        name: 'sr-main',
        baseUrl: mainMock.url,
        apiKeyPlain: E2E_UPSTREAM_KEY,
        priority: 10,
      });
      await addChannel({
        name: 'sr-backup',
        baseUrl: world.upstream.url,
        apiKeyPlain: E2E_UPSTREAM_KEY,
        priority: 5,
      });
      const key = await keys.issue('10');
      const res = await chat(key.raw);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        choices: [{ message: { role: 'assistant' } }],
      });
      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
      // priority 10 严格在前：主渠道收到请求（主渠道挂掉之前备用零调用）
      expect(mainMock.recorded.length).toBe(1);
      expect(world.upstream.recorded.length).toBe(0);
    } finally {
      await mainMock.close();
    }
  });

  it('② 429：当请求换渠成功 + 惩罚箱冷却（第二请求零重复撞击）+ Redis 键', async () => {
    await addChannel({
      name: 'sr-429',
      baseUrl: bad429.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 10,
    });
    const okCh = world.upstream.recorded.length;
    await addChannel({
      name: 'sr-429-backup',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 5,
    });
    const key = await keys.issue('10');

    // 请求 1：坏渠道 429（同渠道收紧重试后仍 429）→ 换渠成功
    const res1 = await chat(key.raw);
    expect(res1.status).toBe(200);
    const badCallsAfterReq1 = bad429.recorded.length;
    expect(badCallsAfterReq1).toBeGreaterThanOrEqual(1); // 撞过一次（429）
    // 惩罚箱已记账（Retry-After 3s → 冷却 3s 内活跃）
    // 注：请求内已触发惩罚（dispatchFailure 收口）——fire-and-forget 落地等待
    await new Promise((r) => setTimeout(r, 300));

    // 请求 2：冷却期内——坏渠道零调用，直达好渠道
    const res2 = await chat(key.raw);
    expect(res2.status).toBe(200);
    expect(bad429.recorded.length).toBe(badCallsAfterReq1); // 零重复撞击
    expect(world.upstream.recorded.length).toBeGreaterThanOrEqual(okCh + 2);

    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  }, 30_000);

  it('③ 死凭据 channel 维：坏 Key 渠道 3 次后整体跳过；同 host 好渠道不连坐', async () => {
    // 坏 Key 与好 Key 同一 mock（同 baseUrl = 同 host）：坏 Key 401 → invalid_api_key
    const badKeyId = await addChannel({
      name: 'sr-dead',
      baseUrl: world.upstream.url,
      apiKeyPlain: 'sk-wrong-key-e2e',
      priority: 10,
    });
    await addChannel({
      name: 'sr-dead-backup',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 5,
    });
    const key = await keys.issue('10');
    const authSeen = () =>
      world.upstream.rejectedAuth.filter((a) => a === 'Bearer sk-wrong-key-e2e').length;

    // 3 个请求：每次坏渠道 401 → 换渠成功（连续计数 1→3）
    for (let i = 0; i < 3; i++) {
      const res = await chat(key.raw);
      expect(res.status).toBe(200);
    }
    expect(authSeen()).toBe(3); // 每请求撞一次坏 Key（401 不可重试、无同渠道重试）

    // 第 4 个请求：死凭据达阈值（3）→ 坏渠道在门前被拒，零上游调用
    const res4 = await chat(key.raw);
    expect(res4.status).toBe(200);
    expect(authSeen()).toBe(3);
    // Redis 键事实：credential:ch:{badKeyId} = invalid（channel 维——好渠道不连坐）
    const cred = (await healthKeyOf(`credential:ch:${badKeyId}`)) as { status?: string } | null;
    expect(cred?.status).toBe('invalid');
    // 好渠道（同 host）正常放行——请求 4 已是成功 200 的证据（走的就是它）
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  }, 30_000);

  it('④ 上游挂：网络拒连 → 换渠成功；连续失败后 host 熔断 open（Redis 键）', async () => {
    await addChannel({
      name: 'sr-down',
      baseUrl: deadUpstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 10,
    });
    await addChannel({
      name: 'sr-down-backup',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 5,
    });
    const key = await keys.issue('10');

    // 每请求一次 network 失败记账（circuitTrip）——5 个请求达熔断阈值
    for (let i = 0; i < 5; i++) {
      const res = await chat(key.raw);
      expect(res.status).toBe(200); // 每次都换渠成功
    }
    await new Promise((r) => setTimeout(r, 300));
    const breaker = (await healthKeyOf(
      `breaker:openai-compatible://${new URL(deadUpstream.url).host}`,
    )) as { state?: string } | null;
    expect(breaker?.state).toBe('open');

    // 熔断 open 后：坏渠道在门前被拒（不再有连接尝试）——请求依旧成功
    const res6 = await chat(key.raw);
    expect(res6.status).toBe(200);
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  }, 60_000);

  it('⑤ 渠道预算硬闸：敞口 > 余额的渠道零上游调用，直达备用', async () => {
    await addChannel({
      name: 'sr-poor',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 10,
      budget: '0.0000001', // 任何请求敞口都超
    });
    await addChannel({
      name: 'sr-poor-backup',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 5,
    });
    const key = await keys.issue('10');
    const before = world.upstream.recorded.length;
    const res = await chat(key.raw);
    expect(res.status).toBe(200);
    // 主渠道敞口被门前硬闸拒绝：上游只收到备用渠道的调用
    expect(world.upstream.recorded.length).toBe(before + 1);
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  });
});

/** 场景② 的 Redis 惩罚键断言独立提取（fire-and-forget 记账落地时机解耦） */
describe.skipIf(!hasEnv)('E2E 惩罚箱 Redis 键事实', () => {
  it('429 记账后 penalty:ch:{id} 冷却窗口活跃', async () => {
    const badChId = await addChannel({
      name: 'sr-429-key',
      baseUrl: bad429.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 10,
    });
    await addChannel({
      name: 'sr-429-key-backup',
      baseUrl: world.upstream.url,
      apiKeyPlain: E2E_UPSTREAM_KEY,
      priority: 5,
    });
    const key = await keys.issue('10');
    const res = await chat(key.raw);
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const penalty = (await healthKeyOf(`penalty:ch:${badChId}`)) as {
      kind?: string;
      until?: number;
      consecutive?: number;
    } | null;
    expect(penalty?.kind).toBe('rate_limited');
    expect(penalty?.consecutive).toBeGreaterThanOrEqual(1);
    expect(penalty?.until).toBeGreaterThan(Date.now());
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  }, 30_000);
});

/** 热配置链路：routing_policies 行落库 → gateway TTL 拾取 → 新参数生效（不重启） */
describe.skipIf(!hasEnv)('E2E 路由策略热配置', () => {
  it('写库后 TTL 内生效：429 冷却时长从缺省 2000ms 热切换到 1000ms（until 差值证明）', async () => {
    const gw = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
    try {
      for (let i = 0; i < 50; i += 1) {
        if ((await gw.assembly.redis.ping().catch(() => '')) === 'PONG') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 500)); // 限流闸连接就绪余量
      // 热短 mock：Retry-After 不发（0）——冷却时长完全由策略参数决定（可观察向量）
      const hot429 = startMockUpstream();
      await hot429.ready;
      hot429.script = 'rate-limit';
      hot429.rateLimitRetryAfterSec = 0;
      try {
        await addChannel({
          name: 'hot-429',
          baseUrl: hot429.url,
          apiKeyPlain: E2E_UPSTREAM_KEY,
          priority: 10,
        });
        await addChannel({
          name: 'hot-backup',
          baseUrl: world.upstream.url,
          apiKeyPlain: E2E_UPSTREAM_KEY,
          priority: 5,
        });
        const key = await keys.issue('10');
        // 本场景的请求全部打短 TTL 网关 gw（chat() 绑定的是外层 15s TTL 网关）
        const hotChat = (raw: string) =>
          e2ePost(gw.baseUrl, raw, {
            model: E2E_MODEL,
            messages: [{ role: 'user', content: 'hot policy' }],
          });

        // 请求 1：缺省策略下 429 → 惩罚冷却 = base 2000ms（无 Retry-After）
        const res1 = await hotChat(key.raw);
        expect(res1.status).toBe(200);
        await new Promise((r) => setTimeout(r, 300)); // fire-and-forget 记账落地
        const before = await penaltyRemainingOf(gw, 'hot-429');
        expect(before).toBeGreaterThan(1_500); // 缺省 base 2000

        // 写入合法热策略：base=max=1000（满足 schema min 与交叉校验）
        const policy = {
          enabled: true,
          scorers: {
            cacheAffinity: { enabled: false, boost: 3, ttlMs: 300_000, prefixChars: 4_096 },
            budgetWatermark: { enabled: true, softRatio: 0.2 },
          },
          retry: { sameChannelMaxRetries: 2 },
          penalty: {
            rateLimitBaseMs: 1_000,
            rateLimitMaxMs: 1_000,
            quotaMs: 60_000,
            conditionalBypass: true,
          },
          modelDead: { failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 },
          wait: { enabled: false, maxWaitMs: 100 },
        };
        await world.db.execute(
          sql`insert into routing_policies (scope, version, policy)
             values ('global', '1', ${JSON.stringify(policy)}::jsonb)
             on conflict (scope) do update set policy = ${JSON.stringify(policy)}::jsonb, updated_at = now()`,
        );
        // 等 TTL 拾取（1s + 余量）+ 上轮冷却过期（2000ms）
        await new Promise((r) => setTimeout(r, 2_400));

        // 请求 2：热策略下 429 → 惩罚冷却 = base 1000ms（差值即热生效证据）
        const res2 = await hotChat(key.raw);
        expect(res2.status).toBe(200);
        await new Promise((r) => setTimeout(r, 300));
        const after = await penaltyRemainingOf(gw, 'hot-429');
        expect(after).toBeGreaterThan(500); // 1000ms 冷却，已耗 ~300ms
        expect(after).toBeLessThan(1_000); // 若仍是缺省 2000ms 会 >1500——热参数已生效

        await keys.settleAll(key.userId);
        await keys.assertReconciled(key.userId, '10');
      } finally {
        await hot429.close();
      }
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

/**
 * 场景⑥ cache 亲和（sticky）：策略热启用 → 粘滞键 Redis 事实 + 反绑定。
 * 确定性观测点说明：ranker 层内是加权随机（rng 不可经装配注入，boost schema 上限
 * 5 → 同层双渠道首选概率 5/6），「同指纹请求必落同渠道」无法确定性断言——
 * 本场景以粘滞键事实（值 = 服务渠道 + TTL 对齐）与 429 反绑定（boost 不绑定）
 * 收口，排序boost 效应由 ranker 单测（注入 rng）确定性覆盖。
 */
describe.skipIf(!hasEnv)('E2E cache 亲和（sticky）', () => {
  it('启用 cacheAffinity：结算后粘滞键落 Redis（值=服务渠道、按指纹分键）；粘滞渠道 429 后同指纹请求换渠成功', async () => {
    // 策略先行落库：gw 装配的首次 refresh 即取到（免 TTL 等待）
    const policy = {
      enabled: true,
      scorers: {
        cacheAffinity: { enabled: true, boost: 5, ttlMs: 300_000, prefixChars: 4_096 },
        budgetWatermark: { enabled: true, softRatio: 0.2 },
      },
      retry: { sameChannelMaxRetries: 1 },
      penalty: {
        rateLimitBaseMs: 2_000,
        rateLimitMaxMs: 60_000,
        quotaMs: 1_800_000,
        conditionalBypass: true,
      },
      modelDead: { failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 },
      wait: { enabled: false, maxWaitMs: 100 },
    };
    await world.db.execute(
      sql`insert into routing_policies (scope, version, policy)
         values ('global', '1', ${JSON.stringify(policy)}::jsonb)
         on conflict (scope) do update set policy = ${JSON.stringify(policy)}::jsonb, updated_at = now()`,
    );
    const gw = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
    try {
      for (let i = 0; i < 50; i += 1) {
        if ((await gw.assembly.redis.ping().catch(() => '')) === 'PONG') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      // 粘滞键 TTL 300s 会跨运行残留（resetChannelHealth 只覆盖 inference:health:*）
      await clearStickyKeys(gw);
      await new Promise((r) => setTimeout(r, 500)); // 首次策略 refresh 落地余量

      const stickyA = startMockUpstream();
      const stickyB = startMockUpstream();
      // ready 屏障：缺省 url 空串会落库 base_url_override='' → 路由 invalid_config 竞态
      await stickyA.ready;
      await stickyB.ready;
      try {
        await addChannel({
          name: 'st-a',
          baseUrl: stickyA.url,
          apiKeyPlain: E2E_UPSTREAM_KEY,
          priority: 10,
        });
        await addChannel({
          name: 'st-b',
          baseUrl: stickyB.url,
          apiKeyPlain: E2E_UPSTREAM_KEY,
          priority: 10,
        });
        const key = await keys.issue('10');
        // 本场景请求全部打短 TTL 网关 gw（策略只在其上生效）
        const stickyChat = (raw: string, content: string) =>
          e2ePost(gw.baseUrl, raw, {
            model: E2E_MODEL,
            messages: [{ role: 'user', content }],
          });

        // 请求 1（指纹 A）：落点渠道 X 由录制分桶识别（auto 脚本必 200——单渠道服务）
        const a0 = stickyA.recorded.length;
        const b0 = stickyB.recorded.length;
        const res1 = await stickyChat(key.raw, 'sticky fingerprint alpha conversation');
        expect(res1.status).toBe(200);
        const onA = stickyA.recorded.length > a0;
        const onB = stickyB.recorded.length > b0;
        expect(onA !== onB).toBe(true);
        const xName = onA ? 'st-a' : 'st-b';
        const xMock = onA ? stickyA : stickyB;
        const yMock = onA ? stickyB : stickyA;

        // 粘滞键事实：值 == 服务渠道 id，TTL 对齐策略 ttlMs（300s 档）
        // 注：sticky 写入是 fire-and-forget（同场景② penalty 记账——落地等待）
        await new Promise((r) => setTimeout(r, 300));
        const settled = await stickyEntries(gw);
        expect(settled).toHaveLength(1);
        expect(settled[0]?.value).toBe(String(await channelIdOf(xName)));
        expect(settled[0]?.ttlMs).toBeGreaterThan(0);
        expect(settled[0]?.ttlMs).toBeLessThanOrEqual(300_000);

        // 请求 2（指纹 B，不同前缀）：新粘滞键（指纹隔离——按键分桶）
        const res2 = await stickyChat(key.raw, 'sticky fingerprint beta conversation');
        expect(res2.status).toBe(200);
        await new Promise((r) => setTimeout(r, 300));
        expect(await stickyEntries(gw)).toHaveLength(2);

        // 请求 3（同指纹 A，粘滞渠道 429）：boost 不绑定——请求仍经另一渠道成功
        xMock.script = 'rate-limit';
        xMock.rateLimitRetryAfterSec = 0; // 无 Retry-After：不引入同渠道等待与额外冷却变量
        const yBefore = yMock.recorded.length;
        const res3 = await stickyChat(key.raw, 'sticky fingerprint alpha conversation');
        expect(res3.status).toBe(200);
        expect(yMock.recorded.length).toBe(yBefore + 1); // 服务方是另一渠道

        await keys.settleAll(key.userId);
        await keys.assertReconciled(key.userId, '10');
      } finally {
        await stickyA.close();
        await stickyB.close();
      }
    } finally {
      await gw.stop();
    }
  }, 60_000);
});

/** 按渠道名查惩罚剩余毫秒（0 = 无惩罚/已过期） */
async function penaltyRemainingOf(
  gw: { assembly: { redis: { get(key: string): Promise<string | null> } } },
  name: string,
): Promise<number> {
  const rows = await world.db.execute<{ id: number }>(
    sql`select id from channels where name = ${name} limit 1`,
  );
  const id = rows[0]?.id;
  if (id == null) return 0;
  const raw = await gw.assembly.redis.get(`inference:health:penalty:ch:${id}`);
  if (raw == null) return 0;
  const state = JSON.parse(raw) as { until: number };
  return Math.max(0, state.until - Date.now());
}

/** 清共享 Redis 的粘滞键（场景隔离：键 TTL 300s 跨运行残留） */
async function clearStickyKeys(gw: E2EGateway): Promise<void> {
  const { redis } = gw.assembly;
  const found: string[] = [];
  const stream = redis.scanStream({ match: 'inference:sticky:*', count: 100 });
  for await (const batch of stream) found.push(...(batch as string[]));
  if (found.length > 0) await redis.del(...found);
}

/** 当前粘滞键面（值 = 渠道 id 字符串；TTL ms）——cache 亲和事实的确定性观测点 */
async function stickyEntries(
  gw: E2EGateway,
): Promise<Array<{ key: string; value: string; ttlMs: number }>> {
  const { redis } = gw.assembly;
  const found: string[] = [];
  const stream = redis.scanStream({ match: 'inference:sticky:*', count: 100 });
  for await (const batch of stream) found.push(...(batch as string[]));
  return await Promise.all(
    found.map(async (k) => ({
      key: k,
      value: defined(await redis.get(k), `sticky ${k}`),
      ttlMs: defined(await redis.pttl(k), `sticky ttl ${k}`),
    })),
  );
}

/** 按渠道名查 id（粘滞键值断言用） */
async function channelIdOf(name: string): Promise<number> {
  const rows = await world.db.execute<{ id: number }>(
    sql`select id from channels where name = ${name} limit 1`,
  );
  return defined(rows[0], `channel ${name}`).id;
}
