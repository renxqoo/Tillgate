/**
 * E2E 渠道成本价双轨定价（docs/channel-cost-pricing.md）：
 *   ① 免费渠道（绑定成本全 0）：敞口按成本 0 预留——微额进货预算下放行 200，
 *      usage_logs.upstream_cost = 0 而用户侧照常计价（旧实现按映射官方价预留 → 503）；
 *   ② 折扣渠道（成本 = 官方 1/10）：结算 upstream_cost 按成本轴、amount 按用户轴
 *      （毛利事实可直接从两列读出）；
 *   ③ costAffinity 开启：同层内流量偏向便宜渠道（策略缺省关闭——本用例显式开启）。
 *
 * 运行条件（默认门禁外）：DB_TEST_URL 或 DATABASE_URL；Redis 同 smart-routing。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  e2ePost,
  setupE2EWorld,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';
import { E2E_UPSTREAM_KEY, startMockUpstream, type MockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

const CC_MODEL = 'cc-model';
const CC_REAL = 'cc-real';
/** 官方价 100_000 元/M（=0.1 元/token）：旧口径敞口 ≈ (输入上界+8)×0.1 元，微额预算必拒 */
const OFFICIAL = '100000';
/** 折扣/便宜渠道成本 10_000 元/M（=0.01 元/token） */
const DISCOUNT = '10000';

let world: E2EWorld;
let gateway: E2EGateway;
let keys: E2EKeys;
/** free = 成本全 0（微额进货预算）；discount = 1/10 成本；cheap/dear = 同层比价 */
let free: MockUpstream;
let discount: MockUpstream;
let cheap: MockUpstream;
let dear: MockUpstream;
let mappingId: number;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

async function addChannel(input: {
  name: string;
  baseUrl: string;
  priority: number;
  budget: string;
  cost?: Record<string, string>;
}) {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, ${input.budget})
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model,
      cost_input_price, cost_output_price, cost_cache_input_price, cost_cache_write_price, cost_unit_price)
    values (${mappingId}, ${id}, ${CC_REAL},
      ${input.cost?.inputPrice ?? null}, ${input.cost?.outputPrice ?? null},
      ${input.cost?.cacheInputPrice ?? null}, ${input.cost?.cacheWritePrice ?? null},
      ${input.cost?.unitPrice ?? null})`);
  return id;
}

const chat = (raw: string) =>
  e2ePost(gateway.baseUrl, raw, {
    model: CC_MODEL,
    messages: [{ role: 'user', content: 'cost spec' }],
    max_tokens: 8,
  });

/** 最近一笔 cc-real 用量的双口径（settle 后读 usage_logs——毛利事实源） */
async function lastUsageRow(): Promise<{ amount: string; upstreamCost: string }> {
  const rows = await world.db.execute(sql`
    select amount, upstream_cost from usage_logs
    where real_model = ${CC_REAL} order by id desc limit 1`);
  const row = rows[0] as { amount: string; upstream_cost: string };
  return { amount: row.amount, upstreamCost: row.upstream_cost };
}

async function settleAndRead(userId: number): Promise<{ amount: string; upstreamCost: string }> {
  await keys.settleAll(userId);
  return lastUsageRow();
}

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);

  const mapping = await world.db.execute(sql`
    insert into model_mappings (external_name, real_model, input_price, output_price, cache_input_price)
    values (${CC_MODEL}, ${CC_REAL}, ${OFFICIAL}, ${OFFICIAL}, ${OFFICIAL}) returning id`);
  mappingId = Number((mapping[0] as { id: string | number }).id);

  free = startMockUpstream();
  await free.ready;
  discount = startMockUpstream();
  await discount.ready;
  cheap = startMockUpstream();
  await cheap.ready;
  dear = startMockUpstream();
  await dear.ready;

  // 免费渠道：微额进货预算 + cost_is_free 标记（价格列留空继承——用户裁决：业务判定走标记，
  // 目录解析物化全 0；旧口径官方价敞口 ≈ 数元 → budget_exhausted 503；标记免费 → 放行）
  const freeId = await addChannel({
    name: 'cc-free',
    baseUrl: free.url,
    priority: 30,
    budget: '0.01',
  });
  await world.db.execute(
    sql`update model_channels set cost_is_free = true where channel_id = ${freeId}`,
  );
  await addChannel({
    name: 'cc-discount',
    baseUrl: discount.url,
    priority: 20,
    budget: '1000',
    cost: {
      inputPrice: DISCOUNT,
      outputPrice: DISCOUNT,
      cacheInputPrice: DISCOUNT,
      cacheWritePrice: '0',
      unitPrice: '0',
    },
  });
  // ③ 比价层：同 priority/weight，成本 1:10（独占该层——free/discount 在更高层不参与）
  await addChannel({
    name: 'cc-cheap',
    baseUrl: cheap.url,
    priority: 10,
    budget: '1000',
    cost: {
      inputPrice: DISCOUNT,
      outputPrice: DISCOUNT,
      cacheInputPrice: DISCOUNT,
      cacheWritePrice: '0',
      unitPrice: '0',
    },
  });
  await addChannel({
    name: 'cc-dear',
    baseUrl: dear.url,
    priority: 10,
    budget: '1000',
    cost: {
      inputPrice: OFFICIAL,
      outputPrice: OFFICIAL,
      cacheInputPrice: OFFICIAL,
      cacheWritePrice: '0',
      unitPrice: '0',
    },
  });
});

afterAll(async () => {
  await [free, discount, cheap, dear].reduce(async (p, m) => {
    await p;
    await m.close();
  }, Promise.resolve());
  await gateway.stop();
  await world.teardown();
});

describe.skipIf(!hasEnv)('E2E 渠道成本价双轨定价', () => {
  it('① 免费渠道：成本 0 敞口放行（微额预算），upstream_cost=0 且用户侧照常计价', async () => {
    const key = await keys.issue('100');
    const res = await chat(key.raw);
    expect(res.status).toBe(200);
    expect(free.recorded.length).toBeGreaterThanOrEqual(1);
    const row = await settleAndRead(key.userId);
    // 成本轴：绑定全 0 → 渠道侧成本恒 0（旧实现按官方价 > 0）
    expect(Number(row.upstreamCost)).toBe(0);
    // 用户轴不受成本影响：mock usage 10 入 5 出 × 0.1 元/token = 1.5 元
    expect(Number(row.amount)).toBeCloseTo(1.5, 6);
    await keys.assertReconciled(key.userId, '100');
    // 让位②：停用免费渠道，路由落到折扣渠道（priority 20）
    await world.db.execute(sql`update channels set status = 1 where name = 'cc-free'`);
  }, 30_000);

  it('② 折扣渠道：upstream_cost 按成本轴（1/10），amount 按用户官方轴——毛利直接可读', async () => {
    const key = await keys.issue('100');
    const res = await chat(key.raw);
    expect(res.status).toBe(200);
    expect(discount.recorded.length).toBeGreaterThanOrEqual(1);
    const row = await settleAndRead(key.userId);
    // 成本轴：10+5 token × 0.01 元 = 0.15；用户轴：× 0.1 = 1.5（毛利 1.35）
    expect(Number(row.upstreamCost)).toBeCloseTo(0.15, 6);
    expect(Number(row.amount)).toBeCloseTo(1.5, 6);
    await keys.assertReconciled(key.userId, '100');
    // 让位③：停用折扣渠道，只剩同层比价双渠道（cheap/dear 同 priority）
    await world.db.execute(sql`update channels set status = 1 where name = 'cc-discount'`);
  }, 30_000);

  it('③ costAffinity 开启：同层流量偏向便宜渠道', async () => {
    await world.db.execute(sql`
      insert into routing_policies (scope, version, policy)
      values ('global', '1', ${JSON.stringify({ enabled: true, scorers: { costAffinity: { enabled: true, floor: 0.1 } } })}::jsonb)
      on conflict (scope) do update set policy = ${JSON.stringify({ enabled: true, scorers: { costAffinity: { enabled: true, floor: 0.1 } } })}::jsonb, updated_at = now()`);
    await new Promise((r) => setTimeout(r, 1_800)); // TTL 1s + 余量

    const key = await keys.issue('100');
    const cheapBefore = cheap.recorded.length;
    const dearBefore = dear.recorded.length;
    for (let i = 0; i < 24; i += 1) {
      const res = await chat(key.raw);
      expect(res.status).toBe(200);
      // 逐笔驱动结算：预扣 ~5 元/笔若不释放会叠加穿钱包（结算异步滞后于响应）
      await keys.settleAll(key.userId);
    }
    const cheapHits = cheap.recorded.length - cheapBefore;
    const dearHits = dear.recorded.length - dearBefore;
    // 便宜 factor 1 vs 贵 factor 0.1（floor）→ 期望 ≈ 22:2；断言方向性（便宜占多数）
    expect(cheapHits + dearHits).toBe(24);
    expect(cheapHits).toBeGreaterThan(dearHits);
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '100');
  }, 60_000);
});
