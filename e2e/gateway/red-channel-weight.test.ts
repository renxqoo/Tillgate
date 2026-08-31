/**
 * 回归（原红测，2026-08-31 weight 单轨化后转绿）：渠道权重配置参与路由。
 * 用户裁决 D4：路由排序单轨读 channels.weight/priority（渠道管理页唯一入口），
 * model_channels 的 weight/priority 列已迁移清退（0107）。
 *
 * 历史问题（转绿前）：管理台唯一权重入口（渠道表单，写 channels.weight）对
 * 实际流量分布零影响——路由读 model_channels.weight（恒缺省 1）→ 五五开随机。
 *
 * 本测试复刻运营真实操作序列（只设渠道级权重、绑定不含权重），
 * 断言高权重渠道承载绝大多数流量（kit 基线已启用智能路由 enabled=true）。
 *
 * 运行条件（默认门禁外）：DB_TEST_URL 或 DATABASE_URL（隔离 schema 自建）；
 * Redis 缺省 redis://:root123@127.0.0.1:6379（E2E_REDIS_URL 覆盖）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_MODEL,
  E2E_REAL_MODEL,
  e2ePost,
  resetChannelHealth,
  setupE2EWorld,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';
import { E2E_UPSTREAM_KEY, startMockUpstream } from './upstream';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

let world: E2EWorld;
let gateway: E2EGateway;
let keys: E2EKeys;
/** 高权重渠道的独立 mock（recorded 分桶即渠道维调用证据） */
let heavyMock: ReturnType<typeof startMockUpstream>;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

/** 与管理台渠道创建等价：写渠道级 weight/priority（channels 表） */
async function addChannelAsAdmin(input: {
  name: string;
  baseUrl: string;
  weight: number;
}): Promise<number> {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, weight, priority, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.weight}, 0, '1000')
    returning id`);
  return Number((r[0] as { id: string | number }).id);
}

/** 与管理台 bindChannelsAction payload 完全等价：仅 channelId + upstreamModel，
 * 不含 weight/priority（生产前端无此字段——model_channels.weight 恒落缺省 1） */
async function bindAsAdmin(channelId: number): Promise<void> {
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${world.seed.mappingId}, ${channelId}, ${E2E_REAL_MODEL})`);
}

const chat = (raw: string) =>
  e2ePost(gateway.baseUrl, raw, {
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'red test: channel weight' }],
    max_tokens: 8,
  });

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
  heavyMock = startMockUpstream();
  await heavyMock.ready;
});

afterAll(async () => {
  await heavyMock.close();
  await gateway.stop();
  await world.teardown();
});

beforeEach(async () => {
  await resetChannelHealth(gateway);
  await world.db.execute(
    sql`delete from model_channels where mapping_id = ${world.seed.mappingId}`,
  );
});

describe.skipIf(!hasEnv)('回归：渠道级 weight=100:1 压倒性倾斜流量（渠道层单轨）', () => {
  it('运营只设渠道权重（生产唯一入口）时流量分布应跟随权重', async () => {
    // 运营操作序列：两渠道同 priority，渠道级权重 100:1
    const heavyId = await addChannelAsAdmin({
      name: 'red-heavy',
      baseUrl: heavyMock.url,
      weight: 100,
    });
    const lightId = await addChannelAsAdmin({
      name: 'red-light',
      baseUrl: world.upstream.url,
      weight: 1,
    });
    await bindAsAdmin(heavyId);
    await bindAsAdmin(lightId);

    const key = await keys.issue('50');
    // 40 样本：当前实现（均匀随机）误过 80% 阈值的概率 <0.02%，红测判定稳定
    const total = 40;
    for (let i = 0; i < total; i += 1) {
      const res = await chat(key.raw);
      expect(res.status).toBe(200);
    }

    const heavyCalls = heavyMock.recorded.length;
    const lightCalls = world.upstream.recorded.length;
    // 期望：weight 100:1 → 高权重渠道 ≥80%（期望值 ≈99%）——渠道层权重驱动排序。
    expect(heavyCalls + lightCalls).toBe(total);
    expect(heavyCalls / total).toBeGreaterThan(0.8);
  }, 120_000);
});
