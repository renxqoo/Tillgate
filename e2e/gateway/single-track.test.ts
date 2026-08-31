/**
 * E2E 单渠道直连（policy.enabled 总开关——用户裁决 D1/D2/D3，2026-08-31）：
 *   ① 无策略行（routing_policies 空）：模型多渠道绑定也只走 priority 首选渠道——
 *      首选持续 5xx 时不换渠道不换候选 → 502 upstream_failed，次渠道零调用；
 *   ② 管理台写入 enabled=true 策略后（TTL 拾取，不重启）：同拓扑换渠成功 200。
 * 黑盒子治理的验收：渠道切换只依赖智能路由显式配置，隐式默认逻辑已删除。
 *
 * 运行条件（默认门禁外）：DB_TEST_URL 或 DATABASE_URL；Redis 同 smart-routing。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createCipher } from '@tillgate/runtime';
import {
  E2EKeys,
  E2E_ENCRYPTION_KEY,
  E2E_MODEL,
  E2E_REAL_MODEL,
  e2ePost,
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
/** 首选渠道 mock（server-error 脚本持续 500）与备用渠道 mock（正常） */
let primary: MockUpstream;
let backup: MockUpstream;
const cipher = createCipher(E2E_ENCRYPTION_KEY);

async function addChannel(input: { name: string; baseUrl: string; priority: number }) {
  const r = await world.db.execute(sql`
    insert into channels (provider_id, name, api_key_enc, base_url_override, priority, upstream_budget)
    values (${world.seed.providerId}, ${input.name}, ${cipher.encrypt(E2E_UPSTREAM_KEY)},
            ${input.baseUrl}, ${input.priority}, '1000')
    returning id`);
  const id = Number((r[0] as { id: string | number }).id);
  await world.db.execute(sql`
    insert into model_channels (mapping_id, channel_id, upstream_model)
    values (${world.seed.mappingId}, ${id}, ${E2E_REAL_MODEL})`);
  return id;
}

const chat = (raw: string) =>
  e2ePost(gateway.baseUrl, raw, {
    model: E2E_MODEL,
    messages: [{ role: 'user', content: 'single track spec' }],
    max_tokens: 8,
  });

beforeAll(async () => {
  world = await setupE2EWorld();
  // 本场景基线：无策略行（kit 默认种 enabled 行，这里显式删除——单渠道直连）
  await world.db.execute(sql`delete from routing_policies where scope = 'global'`);
  gateway = await startE2EGateway(world, { ROUTING_POLICY_TTL_MS: '1000' });
  for (let i = 0; i < 50; i += 1) {
    if ((await gateway.assembly.redis.ping().catch(() => '')) === 'PONG') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  keys = new E2EKeys(world, gateway.assembly.billingFacade);
  primary = startMockUpstream();
  await primary.ready;
  primary.script = 'server-error';
  backup = startMockUpstream();
  await backup.ready;
  // 种子渠道解绑，拓扑只留本场景两渠道
  await world.db.execute(
    sql`delete from model_channels where channel_id = ${world.seed.channelId}`,
  );
  await addChannel({ name: 'st-primary', baseUrl: primary.url, priority: 10 });
  await addChannel({ name: 'st-backup', baseUrl: backup.url, priority: 5 });
});

afterAll(async () => {
  await primary.close();
  await backup.close();
  await gateway.stop();
  await world.teardown();
});

describe.skipIf(!hasEnv)('E2E 单渠道直连 ↔ 智能路由总开关', () => {
  it('① 无策略行：首选渠道持续 500 → 不换渠道（502 终局，次渠道零调用）', async () => {
    const key = await keys.issue('10');
    const res = await chat(key.raw);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'inference.upstream_failed' },
    });
    // 唯一首选渠道被撞过、备用渠道零调用——单渠道直连的可观测证据
    expect(primary.recorded.length).toBeGreaterThanOrEqual(1);
    expect(backup.recorded.length).toBe(0);
    await keys.settleAll(key.userId);
  }, 30_000);

  it('② 写入 enabled=true 策略 → TTL 拾取后同拓扑换渠成功（200）', async () => {
    await world.db.execute(sql`
      insert into routing_policies (scope, version, policy)
      values ('global', '1', ${JSON.stringify({ enabled: true })}::jsonb)
      on conflict (scope) do update set policy = ${JSON.stringify({ enabled: true })}::jsonb, updated_at = now()`);
    await new Promise((r) => setTimeout(r, 1_800)); // TTL 1s + 余量

    const key = await keys.issue('10');
    const res = await chat(key.raw);
    expect(res.status).toBe(200);
    expect(backup.recorded.length).toBeGreaterThanOrEqual(1); // 换渠证据
    await keys.settleAll(key.userId);
    await keys.assertReconciled(key.userId, '10');
  }, 30_000);
});
