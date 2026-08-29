/**
 * E2E 绑定级上游模型名（一次建模、多渠道异名）：
 *   ① 出站异名：同一映射双渠道各持厂商拼写——429 换渠后两个 mock 各录得自己的
 *      出站名（旧实现两渠道同发规范名，本旅程在其上必失败）；响应/对账仍规范口径。
 *   ② 渠道白名单热路径交集（channels.models × 绑定出站名）：
 *      未命中剔除 / 命中放行 / NULL 不限 / 空数组不限 四边界。
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
const cipher = createCipher(E2E_ENCRYPTION_KEY);

/** 追加异名绑定渠道（models = 渠道白名单 jsonb 数组；缺省 SQL NULL = 不限）。
 *  jsonb 值走内联字面量——Bun SQL 参数绑定 + ::jsonb 不可靠（null/字符串都会落成
 *  标量 jsonb，null 标量曾熔断路由谓词）；字面量由测试常量构成，单引号已转义 */
async function addAliasedChannel(input: {
  name: string;
  baseUrl: string;
  priority: number;
  upstreamModel: string;
  models?: string[] | null;
}): Promise<number> {
  const modelsValue =
    input.models != null
      ? sql.raw(`'${JSON.stringify(input.models).replaceAll("'", "''")}'::jsonb`)
      : sql.raw('null');
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, weight, upstream_budget, models)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, 1, '1000', ${modelsValue})
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model, weight, priority)
    values (${world.seed.mappingId}, ${id}, ${input.upstreamModel}, 1, ${input.priority})`);
  return id;
}

const chat = (raw: string) =>
  e2ePost(gateway.baseUrl, raw, {
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'e2e model aliasing' }],
  });

beforeAll(async () => {
  world = await setupE2EWorld();
  gateway = await startE2EGateway(world);
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
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

describe.skipIf(!hasEnv)('E2E 绑定级上游模型名', () => {
  it('① 出站异名：429 换渠后两渠道各发各的绑定名；响应与对账走规范口径', async () => {
    const vendorAMock: MockUpstream = startMockUpstream();
    await vendorAMock.ready;
    vendorAMock.script = 'rate-limit';
    const plainMock = startMockUpstream();
    await plainMock.ready;
    try {
      await addAliasedChannel({
        name: 'ma-vendor-a',
        baseUrl: vendorAMock.url,
        priority: 10,
        upstreamModel: `vendor-a/${E2E_REAL_MODEL}`,
      });
      await addAliasedChannel({
        name: 'ma-official',
        baseUrl: plainMock.url,
        priority: 5,
        upstreamModel: E2E_REAL_MODEL,
      });
      const key = await keys.issue('10');

      const res = await chat(key.raw);
      expect(res.status).toBe(200);
      await res.json(); // 消费体（mock 应答透传；出站名断言在录制侧）

      // 对上游：厂商 A 收到厂商拼写，官方渠道收到规范名——旧实现两处同为规范名
      // 厂商 A 每次（429 + 同渠道重试）都用厂商拼写——旧实现发的是规范名
      expect(vendorAMock.recorded.length).toBeGreaterThanOrEqual(1);
      expect(vendorAMock.recorded.every((r) => r.body.model === `vendor-a/${E2E_REAL_MODEL}`)).toBe(
        true,
      );
      expect(plainMock.recorded.length).toBeGreaterThanOrEqual(1);
      expect(plainMock.recorded.every((r) => r.body.model === E2E_REAL_MODEL)).toBe(true);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await vendorAMock.close();
      await plainMock.close();
    }
  }, 30_000);

  it('② 白名单交集：未命中剔除（零调用）、命中放行、NULL 不限；空数组 = 不限', async () => {
    const excludedMock = startMockUpstream();
    await excludedMock.ready;
    const hitMock = startMockUpstream();
    await hitMock.ready;
    const nullMock = startMockUpstream();
    await nullMock.ready;
    const emptyMock = startMockUpstream();
    await emptyMock.ready;
    try {
      // 拓扑：p10 白名单不含绑定名（应被剔）→ p8 命中（应承接）→ p5 NULL 不限
      await addAliasedChannel({
        name: 'ma-wl-excluded',
        baseUrl: excludedMock.url,
        priority: 10,
        upstreamModel: E2E_REAL_MODEL,
        models: ['gpt-unrelated-model'],
      });
      await addAliasedChannel({
        name: 'ma-wl-hit',
        baseUrl: hitMock.url,
        priority: 8,
        upstreamModel: E2E_REAL_MODEL,
        models: [E2E_REAL_MODEL],
      });
      await addAliasedChannel({
        name: 'ma-wl-null',
        baseUrl: nullMock.url,
        priority: 5,
        upstreamModel: E2E_REAL_MODEL,
      });
      const key = await keys.issue('10');

      const res = await chat(key.raw);
      expect(res.status).toBe(200);
      expect(excludedMock.recorded.length).toBe(0); // 未命中 → 路由前剔除
      expect(hitMock.recorded.length).toBe(1); // 命中且 priority 最高 → 承接
      expect(nullMock.recorded.length).toBe(0); // 命中渠道在前，NULL 渠道未被触达

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');

      // 边界补段：唯一绑定渠道白名单为空数组 → 视为不限（与 NULL 同语义）
      await world.db.execute(
        sql`delete from model_channels where channel_id in (
          select id from channels where name like 'ma-wl-%')`,
      );
      await addAliasedChannel({
        name: 'ma-wl-empty',
        baseUrl: emptyMock.url,
        priority: 1,
        upstreamModel: E2E_REAL_MODEL,
        models: [],
      });
      const res2 = await chat(key.raw);
      expect(res2.status).toBe(200);
      expect(emptyMock.recorded.length).toBe(1);

      await keys.settleAll(key.userId);
      await keys.assertReconciled(key.userId, '10');
    } finally {
      await excludedMock.close();
      await hitMock.close();
      await nullMock.close();
      await emptyMock.close();
    }
  }, 30_000);
});
