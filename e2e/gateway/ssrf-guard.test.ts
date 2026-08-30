/**
 * E2E SSRF 守卫专项：上游 baseUrl 指向回环地址（http://127.0.0.1）时，
 * 未开逃生门的网关必须在传输层拦截（零上游调用、零计费）——防止运营侧
 * 渠道配置被用作内网探测跳板。对照面：GATEWAY_AI_ALLOW_LOCAL_URL=true
 * （非生产显式开启）时同一配置照常服务，证明拦截归因于守卫而非装配损坏。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  E2EKeys,
  E2E_MODEL,
  e2ePost,
  setupE2EWorld,
  startE2EGateway,
  type E2EGateway,
  type E2EWorld,
} from './kit';

const hasEnv = process.env.DB_TEST_URL != null || process.env.DATABASE_URL != null;

describe.skipIf(!hasEnv)('E2E SSRF 守卫（回环上游拦截 + 逃生门对照）', () => {
  let world: E2EWorld;
  /** 逃生门关闭（生产同款：SSRF 门控生效） */
  let strictGateway: E2EGateway;
  /** 逃生门开启（kit 缺省——本地 mock 上游依赖它） */
  let laxGateway: E2EGateway;
  let keys: E2EKeys;
  let raw = '';
  let userId = 0;

  beforeAll(async () => {
    world = await setupE2EWorld();
    strictGateway = await startE2EGateway(world, { GATEWAY_AI_ALLOW_LOCAL_URL: 'false' });
    laxGateway = await startE2EGateway(world);
    keys = new E2EKeys(world, laxGateway.assembly.billingFacade);
    const issued = await keys.issue('5');
    raw = issued.raw;
    userId = issued.userId;
  }, 180_000);

  afterAll(async () => {
    if (laxGateway) await laxGateway.stop();
    if (strictGateway) await strictGateway.stop();
    if (world) await world.teardown();
  });

  it('① 逃生门关闭：回环上游请求被拦截——零上游调用、零计费、余额不动', async () => {
    world.upstream.script = 'nonstream-usage';
    world.upstream.recorded.length = 0;
    const res = await e2ePost(strictGateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'ssrf probe' }],
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    await res.text().catch(() => {});
    // 守卫在传输层拒绝——mock 上游一个请求都不该收到
    expect(world.upstream.recorded).toHaveLength(0);

    await keys.settleAll(userId);
    const reconciled = await keys.assertReconciled(userId, '5');
    expect(reconciled.charged).toBe('0');
  }, 60_000);

  it('② 逃生门开启（非生产显式）：同一回环上游配置照常 200 计费（对照面）', async () => {
    const res = await e2ePost(laxGateway.baseUrl, raw, {
      model: E2E_MODEL,
      messages: [{ role: 'user', content: 'lax control' }],
    });
    expect(res.status).toBe(200);
    expect(world.upstream.recorded.length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
