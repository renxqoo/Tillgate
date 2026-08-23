/**
 * admin 管理面旅程 e2e（v1 五个 e2e 的 admin 侧合并旅程;真实 PG + 真监听 + 真 admin 令牌）。
 *
 * v1 e2e 覆盖矩阵（P5 搬迁对照——断言语义不改,装置差异见 kit 头）：
 *   e2e-crud-sweep → §B 全量 CRUD 扫（providers/channels/models/rate-cards/plans/redeem/订阅列表/
 *                     目录源面/rate-card 绑用户删除守卫链/换 Key/改价回显）
 *   e2e-money     → §C 资金（渠道进货幂等/调账 + 用户调账±/赠送/流水/审计——旅程专属用户）
 *   e2e-ops       → §D 观测面（audit/logs/tracing/billing-operations）——stats/usage 族 = P4 pending
 *   e2e-login     → P2 pending（登录面未迁移;会话门以 §A 401/放行断言锁死）
 *   e2e-cross-app → P7 pending（billing-recovery 旅程需 worker;跨 app 归 e2e/billing-recovery）
 * 已知缺口即上列 P2/P4/P7 三项,其余 admin 可观察行为全覆盖。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { call, jsonHeaders, setupE2EAdmin, teardownE2EAdmin, type E2EAdminWorld } from './kit';

let world: E2EAdminWorld | null = null;

beforeAll(async () => {
  world = await setupE2EAdmin();
}, 60_000);

afterAll(async () => {
  if (world !== null) await teardownE2EAdmin(world);
});

function w(): E2EAdminWorld {
  if (world === null) throw new Error('e2e world not ready');
  return world;
}

describe('A. 会话门与探针（e2e-login 的 admin 侧现状面）', () => {
  it('livez/readyz 200(真实 PG);无令牌 401 http.unauthorized;错令牌 401 统一口径', async () => {
    const live = await fetch(`${w().base}/livez`);
    expect(live.status).toBe(200);
    const ready = await (await fetch(`${w().base}/readyz`)).json();
    expect(ready).toEqual({ status: 'ok', dependencies: { postgres: 'up' } });
    const noToken = await fetch(`${w().base}/v1/users`);
    expect(noToken.status).toBe(401);
    expect(await noToken.json()).toMatchObject({ error: { code: 'http.unauthorized' } });
    const badToken = await fetch(`${w().base}/v1/providers`, {
      headers: { authorization: 'Bearer e2e-wrong-token' },
    });
    expect(badToken.status).toBe(401);
    expect(await badToken.json()).toMatchObject({ error: { code: 'http.unauthorized' } });
  });
});

describe('B. CRUD 全量扫（e2e-crud-sweep）', () => {
  it('providers→channels→models(绑定)→rate-cards→plans→订阅列表→redeem→退役清理', async () => {
    const stamp = Date.now();

    const provider = await call(w(), '/v1/providers', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: `e2e-p-${stamp}`, baseUrl: 'http://127.0.0.1:9/v1' }),
    });
    expect(provider.status).toBe(201);
    const providerId = provider.body.id as number;
    const providersListed = await call(w(), `/v1/providers?q=e2e-p-${stamp}`);
    expect(providersListed.status).toBe(200);
    expect(providersListed.body).toMatchObject({ rows: [{ id: providerId }], total: 1 });

    const channel = await call(w(), '/v1/channels', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        providerId,
        name: `e2e-ch-${stamp}`,
        apiKey: 'sk-e2e-test',
        models: [`e2e-m-${stamp}`],
      }),
    });
    expect(channel.status).toBe(201);
    const channelId = channel.body.id as number;
    await call(w(), `/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ upstreamThreshold: '1' }),
    }).then((res) => expect(res.status).toBe(200));

    const model = await call(w(), '/v1/models', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        externalName: `e2e-m-${stamp}`,
        realModel: `e2e-real-${stamp}`,
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.1',
      }),
    });
    expect(model.status).toBe(201);
    const mappingId = model.body.id as number;
    const bound = await call(w(), `/v1/models/${mappingId}/channels`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ channels: [{ channelId }] }),
    });
    expect(bound.body).toMatchObject({ ok: true, bound: 1 });

    const card = await call(w(), '/v1/rate-cards', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: `e2e-rc-${stamp}`, coefficient: '0.900' }),
    });
    expect(card.status).toBe(201);
    const cardId = card.body.id as number;
    const health = await call(w(), `/v1/rate-cards/${cardId}/health`);
    expect(health.body).toMatchObject({ hasGlobalCoefficient: true, coefficient: '0.900' });

    const plan = await call(w(), '/v1/plans', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        name: `e2e-plan-${stamp}`,
        price: '30',
        periodDays: 30,
        quotaAmount: '100',
      }),
    });
    expect(plan.status).toBe(201);
    const planId = plan.body.id as number;
    expect(plan.body).toMatchObject({ price: '30', kind: 'subscription' });
    const subscriptions = await call(w(), `/v1/subscriptions?planId=${planId}`);
    expect(subscriptions.status).toBe(200);
    expect(subscriptions.body).toMatchObject({ total: 0 });

    const batch = await call(w(), '/v1/redeem-batches', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ name: `e2e-batch-${stamp}`, amount: '10', count: 2 }),
    });
    expect(batch.status).toBe(201);
    const batchId = (batch.body.batch as { id: number }).id;
    expect(batch.body.codes as string[]).toHaveLength(2);
    const codePage = await call(w(), `/v1/redeem-batches/${batchId}/codes`);
    const firstCode = (codePage.body.rows as Array<{ id: number; codeMasked: string }>)[0]!;
    expect(firstCode.codeMasked).toMatch(/^[0-9a-f]{8}\*\*\*\*[0-9a-f]{4}$/);
    expect(
      await call(w(), `/v1/redeem-batches/codes/${firstCode.id}/revoke`, { method: 'POST' }),
    ).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(
      (await call(w(), `/v1/redeem-batches/codes/${firstCode.id}/revoke`, { method: 'POST' }))
        .status,
    ).toBe(404);

    // rate-card 绑用户守卫链（v1 crud-sweep:绑用户 → 删除被拒 409 → 解绑 → 删除）
    const guardUser = await w().provisionUser();
    const bound1 = await call(w(), `/v1/users/${guardUser.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ rateCardId: cardId }),
    });
    expect(bound1.status).toBe(200);
    const guarded = await call(w(), `/v1/rate-cards/${cardId}`, { method: 'DELETE' });
    expect(guarded.status).toBe(409);
    expect(guarded.status).toBe(409);
    expect(guarded.body).toMatchObject({ error: { code: 'control_plane.rate_card_in_use' } });
    await call(w(), `/v1/users/${guardUser.id}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ rateCardId: null }),
    }).then((res) => expect(res.status).toBe(200));
    expect((await call(w(), `/v1/rate-cards/${cardId}`, { method: 'DELETE' })).status).toBe(200);

    // 目录面:sources 200;未知源 404（vendor-catalog = P6 pending）
    const sources = await call(w(), '/v1/model-catalog/sources');
    expect(sources.status).toBe(200);
    expect((sources.body.sources as unknown[]).length).toBeGreaterThanOrEqual(1);
    // 形状合法但未注册的源 → control-plane 目录面 404(admin.* 码只守形状非法路径)
    const unknownSource = await call(w(), '/v1/model-catalog/nope');
    expect(unknownSource.status).toBe(404);
    expect(unknownSource.body).toMatchObject({
      error: { code: 'control_plane.catalog_source_not_found' },
    });

    // 退役清理（数据卫生;plans 无订阅引用可删——e2e 域内闭环）
    for (const [path, method] of [
      [`/v1/models/${mappingId}`, 'DELETE'],
      [`/v1/plans/${planId}`, 'DELETE'],
      [`/v1/channels/${channelId}`, 'DELETE'],
      [`/v1/providers/${providerId}`, 'DELETE'],
    ] as const) {
      expect((await call(w(), path, { method })).status, path).toBe(200);
    }

    // 删除（逻辑删除）后：默认列表不可见，回收站可见且 status 压 1
    const afterDelete = await call(w(), `/v1/providers?q=e2e-p-${stamp}`);
    expect((afterDelete.body.rows as unknown[]).length).toBe(0);
    const recycled = await call(w(), `/v1/providers?q=e2e-p-${stamp}&view=deleted`);
    expect((recycled.body.rows as Array<{ status: number }>)[0]!.status).toBe(1);
  });

  it('channels 换 Key 复位 + 列表富化;models 改价与列表 channelIds 回显', async () => {
    const stamp = Date.now();
    const providerId = (
      await call(w(), '/v1/providers', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: `e2e-rich-p-${stamp}`, baseUrl: 'http://127.0.0.1:9/v1' }),
      })
    ).body.id as number;
    const channelId = (
      await call(w(), '/v1/channels', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ providerId, name: `e2e-rich-ch-${stamp}`, apiKey: 'sk-e2e-1' }),
      })
    ).body.id as number;
    // 换 Key（明文不回显;更新成功即可）+ 上游阈值
    const rotated = await call(w(), `/v1/channels/${channelId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ apiKey: 'sk-e2e-2', upstreamThreshold: '5' }),
    });
    expect(rotated.status).toBe(200);
    const channelsListed = await call(w(), `/v1/channels?q=e2e-rich-ch-${stamp}`);
    const chRow = (channelsListed.body.rows as Array<Record<string, unknown>>)[0]!;
    expect(chRow).toMatchObject({ upstreamThreshold: '5', upstreamRemaining: '0' });
    expect(JSON.stringify(chRow)).not.toContain('sk-e2e');

    const mappingId = (
      await call(w(), '/v1/models', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          externalName: `e2e-rich-m-${stamp}`,
          realModel: 'x',
          inputPrice: '1',
          outputPrice: '1',
          cacheInputPrice: '0',
        }),
      })
    ).body.id as number;
    await call(w(), `/v1/models/${mappingId}/channels`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ channels: [{ channelId }] }),
    });
    const repriced = await call(w(), `/v1/models/${mappingId}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify({ inputPrice: '3' }),
    });
    expect(repriced.body).toMatchObject({ inputPrice: '3' });
    const modelsListed = await call(w(), `/v1/models?q=e2e-rich-m-${stamp}`);
    expect((modelsListed.body.rows as Array<Record<string, unknown>>)[0]!).toMatchObject({
      channelIds: [channelId],
    });

    await call(w(), `/v1/models/${mappingId}`, { method: 'DELETE' });
    await call(w(), `/v1/channels/${channelId}`, { method: 'DELETE' });
    await call(w(), `/v1/providers/${providerId}`, { method: 'DELETE' });
  });
});

describe('C. 资金旅程（e2e-money;旅程专属用户——真实账本,零真实用户污染）', () => {
  it('渠道进货幂等:同键重放回执/异参 409;调账;流水行', async () => {
    const stamp = Date.now();
    const channel = await call(w(), '/v1/channels', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        providerId: await call(w(), '/v1/providers', {
          method: 'POST',
          headers: jsonHeaders,
          body: JSON.stringify({ name: `e2e-funds-p-${stamp}`, baseUrl: 'http://127.0.0.1:9/v1' }),
        }).then((res) => res.body.id as number),
        name: `e2e-funds-ch-${stamp}`,
        apiKey: 'sk-e2e-funds',
      }),
    });
    const channelId = channel.body.id as number;
    const opKey = `e2e-rc-${stamp}`;

    const recharge = await call(w(), '/v1/channel-funds/recharge', {
      method: 'POST',
      headers: jsonHeaders,
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '10' }),
    });
    expect(recharge.body).toMatchObject({ ok: true, balanceAfter: '10', replayed: false });
    const replay = await call(w(), '/v1/channel-funds/recharge', {
      method: 'POST',
      headers: jsonHeaders,
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '10' }),
    });
    expect(replay.body).toMatchObject({ balanceAfter: '10', replayed: true });
    const conflict = await call(w(), '/v1/channel-funds/recharge', {
      method: 'POST',
      headers: jsonHeaders,
      idempotencyKey: opKey,
      body: JSON.stringify({ channelId, amount: '5' }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'control_plane.operation_conflict' } });

    const adjusted = await call(w(), '/v1/channel-funds/adjust', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ channelId, amount: '-3' }),
    });
    expect(adjusted.body).toMatchObject({ balanceAfter: '7' });
    // 超扣守卫(v1 e2e-money:负调账超余额被拒——预算不穿底)
    const overdraft = await call(w(), '/v1/channel-funds/adjust', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ channelId, amount: '-9999' }),
    });
    expect(overdraft.status).toBeGreaterThanOrEqual(400);
    const funds = await call(w(), `/v1/channel-funds?channelId=${channelId}`);
    const rows = funds.body.rows as Array<Record<string, unknown>>;
    expect(rows.some((r) => r.type === 'recharge' && r.amount === '10')).toBe(true);
    expect(rows.some((r) => r.type === 'adjust' && r.amount === '-3')).toBe(true);
    await call(w(), `/v1/channels/${channelId}`, { method: 'DELETE' });
  });

  it('用户资金:调账±/赠送幂等回执/流水信封/审计行(专属用户)', async () => {
    const user = await w().provisionUser();
    const giftKey = `e2e-gift-${user.id}`;

    const gift = await call(w(), `/v1/users/${user.id}/gift`, {
      method: 'POST',
      headers: jsonHeaders,
      idempotencyKey: giftKey,
      body: JSON.stringify({ amount: '10', remark: 'e2e 旅程赠送' }),
    });
    expect(gift.status).toBe(200);
    expect(gift.body).toMatchObject({ ok: true, balanceAfter: '10', replayed: false });
    const giftReplay = await call(w(), `/v1/users/${user.id}/gift`, {
      method: 'POST',
      headers: jsonHeaders,
      idempotencyKey: giftKey,
      body: JSON.stringify({ amount: '10', remark: 'e2e 旅程赠送' }),
    });
    expect(giftReplay.body).toMatchObject({ replayed: true });

    const adjustDown = await call(w(), `/v1/users/${user.id}/adjust`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ amount: '-4' }),
    });
    expect(adjustDown.body).toMatchObject({ balanceBefore: '10', balanceAfter: '6' });
    const adjustUp = await call(w(), `/v1/users/${user.id}/adjust`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ amount: '2' }),
    });
    expect(adjustUp.body).toMatchObject({ balanceBefore: '6', balanceAfter: '8' });

    const transactions = await call(w(), `/v1/users/${user.id}/transactions`);
    const txRows = transactions.body.rows as Array<Record<string, unknown>>;
    expect(transactions.body).toMatchObject({ page: 1, pageSize: 20 });
    expect(txRows.length).toBeGreaterThanOrEqual(3);
    expect(txRows.every((r) => r.userId === user.id)).toBe(true);

    // 用户审计行:资金动作同事务落 audit_logs(G1 桥)
    await vi.waitFor(
      async () => {
        const audit = await call(w(), `/v1/users/${user.id}/audit-logs`);
        const actions = (audit.body.rows as Array<{ action: string }>).map((r) => r.action);
        expect(actions).toContain('admin.gift');
        expect(actions).toContain('admin.adjust');
      },
      { timeout: 5_000 },
    );
  });
});

describe('D. 观测面（e2e-ops 的现存子集;stats/usage 族 = P4 pending）', () => {
  it('审计列表命中旅程动作;请求日志/链路信封;死信面空态口径', async () => {
    // q 定向(并发会话的审计行会挤出首页——v1 统一列表契约的 q 命中 action ilike)
    for (const action of [
      'provider.create',
      'channel.create',
      'plan.create',
      'redeem_batch.create',
    ]) {
      await vi.waitFor(
        async () => {
          const page = await call(w(), `/v1/audit-logs?q=${encodeURIComponent(action)}`);
          expect(page.body.total ?? 0, action).toBeGreaterThanOrEqual(1);
          expect(
            (page.body.rows as Array<{ action: string }>).some((r) => r.action === action),
            action,
          ).toBe(true);
        },
        { timeout: 5_000 },
      );
    }
    const logs = await call(w(), '/v1/logs?page_size=5');
    expect(logs.status).toBe(200);
    expect(logs.body).toMatchObject({ page: 1, pageSize: 5 });
    // tracing 五端点全 200（v1 e2e-ops 断言面;detail 用未知 id = 空详情兜底形态）
    expect((await call(w(), '/v1/tracing/recent?page_size=5')).body).toMatchObject({
      page: 1,
      pageSize: 5,
    });
    expect(
      (await call(w(), '/v1/tracing/traces/00000000-0000-4000-8000-0000000000e2')).body,
    ).toMatchObject({ spans: [] });
    expect((await call(w(), '/v1/tracing/by-request/e2e-unknown')).body).toMatchObject({
      spans: [],
    });
    expect((await call(w(), '/v1/tracing/topology?hours=24')).body).toMatchObject({ hours: 24 });
    expect((await call(w(), '/v1/tracing/stats')).status).toBe(200);
    const dead = await call(w(), '/v1/billing-operations?status=dead');
    expect(dead.status).toBe(200);
    expect(dead.body).toMatchObject({ total: expect.any(Number) });
    const fx = await call(w(), '/v1/fx/catalog');
    expect(fx.status).toBe(200);
  });
});
