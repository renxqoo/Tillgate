/**
 * E2E 渠道预算硬闸 × 多候选 fallback 链 × 多用户并发（深水区向量）：
 *   ① 预算耗尽换渠：穷渠道在预算门前被拒（零上游调用）直达备用；全候选预算耗尽
 *      → 503 信封 error.context.upstream_code = 'channel_budget_exhausted'
 *   ② 预留-结算生命周期：运行时探得单请求渠道预留额（billing 公式锁定）→ 结算后
 *      channels.upstream_reserved 归零 + 预算按 upstreamCost（官方价×usage、系数 1）扣减
 *      → 扣减后余额 < 单次预留额 → 换渠
 *   ③ 并发预留竞态：预算恰够 1 次预留时两并发请求恰 1 个落 A（守卫 UPDATE
 *      `budget - reserved >= delta` 无双预留穿透），结算后双请求各有正确渠道归属
 *   ④ fallback_models 候选链：主候选渠道全挂（503）→ 换候选 Y。切换事实成立（上游收到
 *      Y 绑定行出站名），但交付被结算闸拦截——fallback 命中时收据 externalModel=请求名，
 *      validateReceipt 按候选自身对外名严格匹配 → 毒收据 not_authorized →
 *      finalize_unavailable（已知缺陷：事实锁定件通过 + it.fails 规格件锁定期望行为）
 *   ⑤ 多用户并发归属：两用户各并发数请求，usage_logs 与钱包扣减各归各账互不串
 *   ⑥ conditionalBypass：全渠道惩罚冷却时惩罚门放行（仍打上游而非假性 503），
 *      终态 503 信封 upstream_code = 'rate_limited'（isChannelExhausted 词表归渠道面竭尽）
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { modelMappings } from '@tillgate/db';
import { Decimal } from '@tillgate/billing';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_INPUT_PRICE,
  E2E_MODEL,
  E2E_OUTPUT_PRICE,
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
import { E2E_UPSTREAM_KEY, startMockUpstream, type MockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

let world: E2EWorld;
let gateway: E2EGateway;
let keys: E2EKeys;
const cipher = createCipher(E2E_ENCRYPTION_KEY);
/** 本文件创建的 mock 上游（afterAll 统一收口） */
const mocks: MockUpstream[] = [];

/**
 * 预留额探针体：max_tokens=64 → 输出上界确定性小；键序 = chatSchema 声明序
 * （model/messages/…，zod passthrough 重排已知键后与此一致——估算字节口径可复算）。
 */
const PROBE_BODY: Record<string, unknown> = {
  model: E2E_MODEL,
  messages: [{ role: 'user', content: 'agent budget multi fixed probe payload' }],
  max_tokens: 64,
};
/** 该体的单请求渠道预留额（beforeAll 运行时探得 + 公式断言锁定） */
let reserveUnit: Decimal;

/** 渠道资金面（numeric 走 ::text + Decimal 比较——JS 字符串比较是字典序不可用） */
interface ChannelFunds {
  [key: string]: unknown;
  budget: string;
  reserved: string;
  status: number;
}

/** raw execute 的数值列口径：bigint/numeric 均以字符串返回（pg 驱动行为） */
interface UsageRow {
  request_id: string;
  external_model: string;
  real_model: string;
  channel_id: string | null;
  amount: string;
  upstream_cost: string;
  input_tokens: string;
  output_tokens: string;

  [key: string]: unknown;
}

/** 新建 mock 上游（ready 屏障 + 台账登记，脚本由调用方设置） */
async function startMock(): Promise<MockUpstream> {
  const mock = startMockUpstream();
  await mock.ready;
  mocks.push(mock);
  return mock;
}

/** 世界目录追加渠道并绑定映射（缺省绑种子映射；upstreamModel 缺省 = 规范名） */
async function addChannel(input: {
  name: string;
  baseUrl: string;
  apiKeyPlain?: string;
  priority: number;
  budget?: string;
  upstreamModel?: string;
  mappingId?: number;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(input.apiKeyPlain ?? E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, 1, ${input.budget ?? '1000'})
    returning id`);
  const id = Number(defined(r[0] as { id: string | number } | undefined, 'channel insert').id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${input.mappingId ?? world.seed.mappingId}, ${id}, ${input.upstreamModel ?? E2E_REAL_MODEL})`);
  return id;
}

/**
 * 追加模型映射（fallback_models = 对外名 jsonb 数组——buildCandidateChain 按对外名解析）。
 * 必须走 drizzle 类型化 insert：本仓 jsonb 列是 Bun SQL 定制类型（db/schema/jsonb.ts），
 * raw sql 传字符串参数会被 Bun SQL 按字符串标量单层编码——落库成 jsonb 字符串而非数组
 * （候选链会静默退化为单候选，见 kit setFixedReservationPolicy 同注）。
 */
async function addMapping(input: {
  external: string;
  real: string;
  inputPrice: string;
  outputPrice: string;
  cachePrice: string;
  fallback?: string[];
}): Promise<number> {
  const rows = await world.db
    .insert(modelMappings)
    .values({
      externalName: input.external,
      realModel: input.real,
      inputPrice: input.inputPrice,
      outputPrice: input.outputPrice,
      cacheInputPrice: input.cachePrice,
      fallbackModels: input.fallback ?? null,
    })
    .returning({ id: modelMappings.id });
  return defined(rows[0], 'mapping insert').id;
}

async function fundsOf(channelId: number): Promise<ChannelFunds> {
  const rows = await world.db.execute<ChannelFunds>(sql`
    select upstream_budget::text as budget, upstream_reserved::text as reserved, status
    from channels where id = ${channelId}`);
  return defined(rows[0] as ChannelFunds, `channel funds ${channelId}`);
}

async function usageOf(userId: number): Promise<UsageRow[]> {
  const rows = await world.db.execute(sql`
    select request_id, external_model, real_model, channel_id, amount::text, upstream_cost::text,
           input_tokens, output_tokens
    from usage_logs where user_id = ${userId} order by id`);
  return rows as UsageRow[];
}

/** 该用户最新一条 billing_requests 的渠道预留额快照（探针口径） */
async function lastChannelReservedOf(userId: number): Promise<string> {
  const rows = await world.db.execute<{ amount: string }>(sql`
    select channel_reserved_amount::text as amount from billing_requests
    where user_id = ${userId} and channel_reserved_amount is not null
    order by created_at desc limit 1`);
  return defined(defined(rows[0], 'probe billing row').amount, 'probe reserved amount');
}

/** Redis 健康键原始值（惩罚箱/死记忆状态机 JSON） */
async function healthKeyOf(key: string): Promise<unknown> {
  const raw = await gateway.assembly.redis.get(`inference:health:${key}`);
  return raw == null ? null : JSON.parse(raw);
}

function expectDec(actual: string, expected: string | Decimal, label: string): void {
  const exp = expected instanceof Decimal ? expected : new Decimal(expected);
  if (!new Decimal(actual).eq(exp)) {
    throw new Error(`${label}: actual ${actual} != expected ${exp.toString()}`);
  }
}

const chat = (raw: string, body: Record<string, unknown> = PROBE_BODY) =>
  e2ePost(gateway.baseUrl, raw, body);

/** 非流式 mock 固定 usage{10,5} → RX-M3 官方价（系数 1）单笔金额/upstreamCost */
const USAGE_AMOUNT = new Decimal(E2E_INPUT_PRICE)
  .times(10)
  .plus(new Decimal(E2E_OUTPUT_PRICE).times(5))
  .div(1_000_000);

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  // 限流闸 fail-closed：Redis 握手完成前请求会 400——显式等待收敛（同 smart-routing）
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await sleep(100);
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);

  // 共享 Redis 残留（上一运行把 RX-M3 记进模型死记忆，TTL 60s）不得毒化探针——
  // beforeAll 先于 beforeEach 清键，探针才能按 fresh 世界路由
  await resetChannelHealth(gateway);

  // 渠道预留额探针：大预算渠道同体请求一次 → billing_requests.channel_reserved_amount
  // 即该体的单请求预留额（数值事实，供 ②③ 设「恰够 1 次」预算）
  const probeMock = await startMock();
  await addChannel({ name: 'abm-probe', baseUrl: probeMock.url, priority: 10 });
  const probeUser = await keys.issue('10');
  const probeRes = await chat(probeUser.raw);
  expect(probeRes.status).toBe(200);
  reserveUnit = new Decimal(await lastChannelReservedOf(probeUser.userId));
  // 公式锁定（现状契约）：官方价口径 estimateMaxCost、coefficient=1——
  // 输入贵价 = max(输入, 缓存, 缓存写|缺省回落输入) = 2.1，敞口 = (2.1×B + 8.4×64)/1e6
  const bytes = Buffer.byteLength(JSON.stringify(PROBE_BODY), 'utf8');
  const expected = new Decimal(E2E_INPUT_PRICE)
    .times(bytes)
    .plus(new Decimal(E2E_OUTPUT_PRICE).times(64))
    .div(1_000_000);
  expect(reserveUnit.eq(expected)).toBe(true);
  await keys.settleAll(probeUser.userId);
  await keys.assertReconciled(probeUser.userId, '10');
});

afterAll(async () => {
  // 收尾清共享 Redis 健康键（场景⑥会把模型记进死记忆，TTL 60s 跨运行残留毒化他件）
  await resetChannelHealth(gateway);
  for (const mock of mocks) await mock.close();
  await gateway.stop();
  await world.teardown();
});

beforeEach(async () => {
  await resetChannelHealth(gateway);
  // 场景隔离：清全部映射绑定（渠道/映射行保留无害——未绑定不参与路由）
  await world.db.execute(sql`delete from model_channels`);
});

describe.skipIf(!hasEnv)('E2E 渠道预算硬闸 + fallback 链 + 多用户并发', () => {
  it('① 预算耗尽换渠零上游调用；全候选耗尽 503 信封带 channel_budget_exhausted', async () => {
    const mockA = await startMock();
    const mockB = await startMock();
    // A 预算极小：任何请求敞口（≥ 2.1×体字节/1e6 ≈ 2e-4）都超 → 预算门前被拒
    const aId = await addChannel({
      name: 'abm-poor-a',
      baseUrl: mockA.url,
      priority: 10,
      budget: '0.000001',
    });
    const bId = await addChannel({ name: 'abm-ok-b', baseUrl: mockB.url, priority: 5 });
    const user = await keys.issue('10');

    // 请求 1：A 在预算门被拒（零上游调用、零预留），直达 B
    const res1 = await chat(user.raw);
    expect(res1.status).toBe(200);
    expect(mockA.recorded.length).toBe(0);
    expect(mockB.recorded.length).toBe(1);
    const fundsA = await fundsOf(aId);
    expectDec(fundsA.reserved, '0', 'poor channel reserved after gate rejection');
    await keys.settleAll(user.userId);
    await keys.assertReconciled(user.userId, '10');

    // 把 B 也耗尽 → 全候选预算门拒绝 → releaseAndFail 渠道面竭尽 503
    await world.db.execute(sql`update channels set upstream_budget = '0.000001' where id = ${bId}`);
    const res2 = await chat(user.raw);
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as {
      error: { code: string; context?: { model?: string; upstream_code?: string } };
    };
    // 渲染契约：no_available_channel（category unavailable → 503）+ 业务 context 出站
    expect(body2.error.code).toBe('inference.no_available_channel');
    expect(body2.error.context?.model).toBe(E2E_MODEL);
    expect(body2.error.context?.upstream_code).toBe('channel_budget_exhausted');
    // 两渠道零新增上游调用（预算门拒绝发生在 upstream.attempt 之前）
    expect(mockA.recorded.length).toBe(0);
    expect(mockB.recorded.length).toBe(1);
    // 失败请求：钱包在途归零（request_failed 三路释放）、不产生用量、
    // 账单行 [settled（请求1）, released（请求2）]
    const wallet = await keys.walletOf(user.userId);
    expectDec(wallet.inFlight, '0', 'in-flight after failed request');
    expect((await usageOf(user.userId)).length).toBe(1);
    const bills = await keys.billsOf(user.userId);
    expect(bills.map((b) => b.status).toSorted()).toEqual(['released', 'settled']);
  }, 30_000);

  it('② 预留随结算释放归零；预算按 upstreamCost 扣减后不足单次预留 → 换渠', async () => {
    const mockA = await startMock();
    const mockB = await startMock();
    // A 预算恰够 1 次预留（探针值）；B 富余
    const aId = await addChannel({
      name: 'abm-exact-a',
      baseUrl: mockA.url,
      priority: 10,
      budget: reserveUnit.toString(),
    });
    await addChannel({ name: 'abm-rich-b', baseUrl: mockB.url, priority: 5 });
    const user = await keys.issue('10');

    // 请求 1：A 服务成功（结算前预留恰为单次预留额）
    const res1 = await chat(user.raw);
    expect(res1.status).toBe(200);
    expect(mockA.recorded.length).toBe(1);
    expectDec((await fundsOf(aId)).reserved, reserveUnit, 'reserved in flight');

    // 结算（settleAll 驱动至无 pending）：预留释放归零 + 预算按 upstreamCost 扣减
    await keys.settleAll(user.userId);
    const settled = await fundsOf(aId);
    expectDec(settled.reserved, '0', 'reserved after settlement');
    expectDec(settled.budget, reserveUnit.minus(USAGE_AMOUNT), 'budget after settlement');
    expect(settled.status).toBe(0); // 剩余 > 0（threshold NULL → 0）不熔断

    // 请求 2：A 剩余 = 预算 − upstreamCost < 单次预留额 → 预算门拒 → 换渠 B
    const res2 = await chat(user.raw);
    expect(res2.status).toBe(200);
    expect(mockA.recorded.length).toBe(1);
    expect(mockB.recorded.length).toBe(1);

    // 两笔用量渠道归属：第一笔 A、第二笔 B；金额均按官方价公式（现状口径锁定）
    await keys.settleAll(user.userId);
    const usage = await usageOf(user.userId);
    expect(usage.length).toBe(2);
    expect(usage[0]?.channel_id).toBe(String(aId));
    expect(usage[1]?.channel_id).not.toBe(String(aId));
    for (const row of usage) {
      expectDec(row.amount, USAGE_AMOUNT, 'usage amount');
      expectDec(row.upstream_cost, USAGE_AMOUNT, 'usage upstream_cost');
    }
    // 全程结算后两渠道预留均归零
    expectDec((await fundsOf(aId)).reserved, '0', 'a reserved after all settled');
    await keys.assertReconciled(user.userId, '10');
  }, 30_000);

  it('③ 并发预留竞态：预算恰够 1 次预留，两并发请求恰 1 个落 A、无穿透', async () => {
    const mockA = await startMock();
    const mockB = await startMock();
    const aId = await addChannel({
      name: 'abm-race-a',
      baseUrl: mockA.url,
      priority: 10,
      budget: reserveUnit.toString(),
    });
    const bId = await addChannel({
      name: 'abm-race-b',
      baseUrl: mockB.url,
      priority: 5,
      budget: reserveUnit.toString(),
    });
    const user = await keys.issue('10');

    // 两并发同体请求：守卫 UPDATE（budget - reserved >= delta）串行化——
    // 恰 1 个在 A 预留成功，另 1 个 A 被拒换 B（B 预算同样恰够 1 次）
    const [res1, res2] = await Promise.all([chat(user.raw), chat(user.raw)]);
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(mockA.recorded.length).toBe(1);
    expect(mockB.recorded.length).toBe(1);

    // 结算前资金面：A/B 预留各恰 1 次预留额（≤ 预算——双预留穿透会变 2×）
    const fundsA = await fundsOf(aId);
    const fundsB = await fundsOf(bId);
    expectDec(fundsA.reserved, reserveUnit, 'race: A reserved exactly once');
    expect(new Decimal(fundsA.reserved).lte(new Decimal(fundsA.budget))).toBe(true);
    expectDec(fundsB.reserved, reserveUnit, 'race: B reserved exactly once');

    // 结算后：预留归零、两笔用量渠道归属互斥且正确
    await keys.settleAll(user.userId);
    expectDec((await fundsOf(aId)).reserved, '0', 'race: A reserved released');
    expectDec((await fundsOf(bId)).reserved, '0', 'race: B reserved released');
    const usage = await usageOf(user.userId);
    expect(usage.length).toBe(2);
    const channels = usage.map((r) => r.channel_id).toSorted();
    expect(channels).toEqual([String(aId), String(bId)]);
    await keys.assertReconciled(user.userId, '10');
  }, 30_000);

  // 场景④拆两件：切换事实与交付收口（④）+ 计价/对外名规格（④-spec）。
  // 原毒收据闸缺陷（fallback 命中必 not_authorized → 503 + 三路资金滞留）已修复：
  // validateReceipt 的 externalModel 验证改为「属于授权链」（请求名=主候选名合法）。
  it('④ fallback 切换事实：主候选渠道 503 → 上游换候选 Y（出站名= Y 绑定行）→ 交付并结算收口', async () => {
    const mockX = await startMock();
    mockX.script = 'server-error'; // X 渠道上游 503（upstream_error 可换渠→候选耗尽→换候选）
    const mockY = await startMock();
    // Y 价格与 X 不同（×2）：计价归属可观测（规格件断言）
    const mapX = await addMapping({
      external: 'ABM-X',
      real: 'ABM-X-Real',
      inputPrice: E2E_INPUT_PRICE,
      outputPrice: E2E_OUTPUT_PRICE,
      cachePrice: '0.42',
      fallback: ['ABM-Y'],
    });
    const mapY = await addMapping({
      external: 'ABM-Y',
      real: 'ABM-Y-Real',
      inputPrice: '4.2',
      outputPrice: '16.8',
      cachePrice: '0.84',
    });
    await addChannel({
      name: 'abm-fb-x',
      baseUrl: mockX.url,
      priority: 10,
      upstreamModel: 'ABM-X-Vendor',
      mappingId: mapX,
    });
    const yChannelId = await addChannel({
      name: 'abm-fb-y',
      baseUrl: mockY.url,
      priority: 10,
      upstreamModel: 'ABM-Y-Vendor',
      mappingId: mapY,
    });
    const user = await keys.issue('10');

    const res = await chat(user.raw, {
      model: 'ABM-X',
      messages: [{ role: 'user', content: 'fallback chain probe' }],
    });

    // 切换事实：X 确实撞过（同渠道重试后仍 503 → 候选耗尽）；Y 收到恰 1 次，
    // 出站模型名 = Y 绑定行 upstream_model（模型名替换在 ai 适配器层完成）
    expect(mockX.recorded.length).toBeGreaterThanOrEqual(1);
    expect(mockX.recorded[0]?.body.model).toBe('ABM-X-Vendor');
    expect(mockY.recorded.length).toBe(1);
    expect(mockY.recorded[0]?.body.model).toBe('ABM-Y-Vendor');

    // 修复后行为（原毒收据闸缺陷已修）：fallback 命中正常交付 + 结算收口——
    // 客户端 200、账单行结算完成、Y 渠道敞口归还、钱包在途清零
    // （修复：validateReceipt 计价快照按命中候选（mappingId 锁定）、
    // externalModel 验证改为「属于授权链」——请求名=主候选名天然合法）
    expect(res.status).toBe(200);
    await keys.settleAll(user.userId);
    const bills = await keys.billsOf(user.userId);
    expect(bills.every((b) => b.status !== 'in_flight')).toBe(true);
    const reservedOnY = (await fundsOf(yChannelId)).reserved;
    expectDec(reservedOnY, new Decimal(0), 'Y channel reserve released');
    const wallet = await keys.walletOf(user.userId);
    expectDec(wallet.inFlight, new Decimal(0), 'wallet in-flight cleared');
  }, 30_000);

  /**
   * 规格回归件（已修复转绿）：fallback 命中正常交付并按 Y 计价。
   * 原失败根因：validateReceipt 的候选匹配不接受「请求对外名 × 服务候选」组合
   * 上游已成功却永远无法结算 → finalize_unavailable。
   */
  it('④-spec fallback 命中交付与计价：200 + real_model/计价按 Y（毒收据闸已修复——billing 名字验证改为授权链归属）', async () => {
    const mockX = await startMock();
    mockX.script = 'server-error';
    const mockY = await startMock();
    const mapX = await addMapping({
      external: 'ABM-X2',
      real: 'ABM-X2-Real',
      inputPrice: E2E_INPUT_PRICE,
      outputPrice: E2E_OUTPUT_PRICE,
      cachePrice: '0.42',
      fallback: ['ABM-Y2'],
    });
    const mapY = await addMapping({
      external: 'ABM-Y2',
      real: 'ABM-Y2-Real',
      inputPrice: '4.2',
      outputPrice: '16.8',
      cachePrice: '0.84',
    });
    await addChannel({
      name: 'abm-fb-x2',
      baseUrl: mockX.url,
      priority: 10,
      upstreamModel: 'ABM-X2-Vendor',
      mappingId: mapX,
    });
    const yChannelId = await addChannel({
      name: 'abm-fb-y2',
      baseUrl: mockY.url,
      priority: 10,
      upstreamModel: 'ABM-Y2-Vendor',
      mappingId: mapY,
    });
    const user = await keys.issue('10');

    const res = await chat(user.raw, {
      model: 'ABM-X2',
      messages: [{ role: 'user', content: 'fallback chain spec' }],
    });
    expect(res.status).toBe(200);
    expect(mockY.recorded[0]?.body.model).toBe('ABM-Y2-Vendor');

    // 计费归属：对外名 = 请求名；real_model/渠道/金额全按 Y 映射（系数 1 官方价）
    await keys.settleAll(user.userId);
    const usage = await usageOf(user.userId);
    expect(usage.length).toBe(1);
    const row = defined(usage[0], 'fallback usage row');
    expect(row.external_model).toBe('ABM-X2');
    expect(row.real_model).toBe('ABM-Y2-Real');
    expect(row.channel_id).toBe(String(yChannelId));
    expect(row.input_tokens).toBe('10');
    expect(row.output_tokens).toBe('5');
    const yAmount = new Decimal('4.2').times(10).plus(new Decimal('16.8').times(5)).div(1_000_000);
    expectDec(row.amount, yAmount, 'fallback usage amount (Y prices)');
    expectDec(row.upstream_cost, yAmount, 'fallback upstream_cost (Y prices, coeff 1)');
    await keys.assertReconciled(user.userId, '10');
  }, 30_000);

  it('⑤ 多用户并发归属：两用户各 3 并发请求，用量/钱包各归各账互不串', async () => {
    await addChannel({ name: 'abm-mu-1', baseUrl: world.upstream.url, priority: 10 });
    await addChannel({ name: 'abm-mu-2', baseUrl: world.upstream.url, priority: 10 });
    const u1 = await keys.issue('10');
    const u2 = await keys.issue('10');

    // 两用户各 3 请求全并发（同体）：归属正确性在并发下不得串
    const results = await Promise.all([
      ...Array.from({ length: 3 }, () => chat(u1.raw)),
      ...Array.from({ length: 3 }, () => chat(u2.raw)),
    ]);
    for (const res of results) expect(res.status).toBe(200);

    await keys.settleAll(u1.userId);
    await keys.settleAll(u2.userId);
    const usage1 = await usageOf(u1.userId);
    const usage2 = await usageOf(u2.userId);
    expect(usage1.length).toBe(3);
    expect(usage2.length).toBe(3);
    for (const row of [...usage1, ...usage2]) {
      expectDec(row.amount, USAGE_AMOUNT, 'multi-user usage amount');
    }
    // 各自对账：余额 = 充值 − Σ本用户用量（charged 显式锁定 3 × 单笔）
    const rec1 = await keys.assertReconciled(u1.userId, '10');
    const rec2 = await keys.assertReconciled(u2.userId, '10');
    expectDec(rec1.charged, USAGE_AMOUNT.times(3), 'user1 total charged');
    expectDec(rec2.charged, USAGE_AMOUNT.times(3), 'user2 total charged');
  }, 30_000);

  it('⑥ conditionalBypass：全渠道冷却时惩罚门放行（有上游调用，非假性 503）', async () => {
    const mockA = await startMock();
    const mockB = await startMock();
    // Retry-After 0 = 不发头：同渠道退避与冷却时长完全由策略参数决定（可观测）
    mockA.script = 'rate-limit';
    mockA.rateLimitRetryAfterSec = 0;
    mockB.script = 'rate-limit';
    mockB.rateLimitRetryAfterSec = 0;
    const aId = await addChannel({ name: 'abm-429-a', baseUrl: mockA.url, priority: 10 });
    const bId = await addChannel({ name: 'abm-429-b', baseUrl: mockB.url, priority: 5 });
    const user = await keys.issue('10');

    // 请求 1：两渠道轮流 429（可换渠），终局 lastCode=rate_limited → 渠道面竭尽 503
    const res1 = await chat(user.raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'conditional bypass probe' }],
    });
    expect(res1.status).toBe(503);
    const body1 = (await res1.json()) as {
      error: { code: string; context?: { upstream_code?: string } };
    };
    expect(body1.error.code).toBe('inference.no_available_channel');
    expect(body1.error.context?.upstream_code).toBe('rate_limited');
    expect(mockA.recorded.length).toBeGreaterThanOrEqual(1);
    expect(mockB.recorded.length).toBeGreaterThanOrEqual(1);

    // 惩罚箱记账落地（fire-and-forget 有界等待）且两渠道都在冷却（全冷却前置成立）
    await sleep(300);
    for (const id of [aId, bId]) {
      const penalty = (await healthKeyOf(`penalty:ch:${id}`)) as {
        kind?: string;
        until?: number;
      } | null;
      expect(penalty?.kind).toBe('rate_limited');
      expect(penalty?.until ?? 0).toBeGreaterThan(Date.now());
    }

    // 请求 2（冷却窗内）：conditionalBypass 全冷却放行——惩罚门不拦，
    // 两渠道仍被真实尝试（上游调用数增长），而非门前假性 503
    const callsA = mockA.recorded.length;
    const callsB = mockB.recorded.length;
    const res2 = await chat(user.raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'conditional bypass probe' }],
    });
    expect(mockA.recorded.length).toBeGreaterThan(callsA);
    expect(mockB.recorded.length).toBeGreaterThan(callsB);
    // 终态（代码现状）：全败 rate_limited → isChannelExhausted → 503 渠道面竭尽信封
    expect(res2.status).toBe(503);
    const body2 = (await res2.json()) as {
      error: { code: string; context?: { upstream_code?: string } };
    };
    expect(body2.error.code).toBe('inference.no_available_channel');
    expect(body2.error.context?.upstream_code).toBe('rate_limited');
    // 失败请求不结算不占用钱包在途
    const wallet = await keys.walletOf(user.userId);
    expectDec(wallet.inFlight, '0', 'in-flight after 429 exhausted');
    expect((await usageOf(user.userId)).length).toBe(0);
  }, 60_000);
});
