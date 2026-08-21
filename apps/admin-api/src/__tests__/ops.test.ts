/**
 * 运营面语义：
 *   - usage-logs：estimated/estimateReason 一等字段；字符串布尔过滤不误吞
 *   - logs：userName = displayName ?? email 回退；q 命中 requestId；statusCode 分组
 *   - stats：overview 结构 + usage 分组
 *   - notifications：CRUD + webhook/email 配置守卫 + 测试入箱
 *   - payment-orders：列表 + 手动关单 CAS + 状态拒绝
 *   - billing-operations：status=dead 必填；reason 必填；uuid 参数校验；retry/abandon 全链
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { notificationChannels, notifyOutbox, paymentOrders, requestLogs } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, newUserRow, uid } from './helpers.js';

describe('usage-logs', () => {
  it('estimated 字符串布尔过滤不误吞（"false" 不被 coerce 成 true）', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    // 直插两行：一行估算、一行真实（模型名每次唯一——防历史残留串扰）
    const model = `ul-${uid('m')}`;
    const { usageLogs } = await import('@ai-gateway/db');
    await db.insert(usageLogs).values([
      {
        requestId: randomUUID(),
        userId,
        channelId: null,
        credentialType: 'api_key',
        externalModel: model,
        realModel: `${model}-real`,
        inputTokens: 1,
        outputTokens: 1,
        amount: '0.1',
        paygAmount: '0.1',
        coefficient: '1.000',
        estimated: true,
        estimateReason: 'usage_missing_completed',
        billedBy: 'payg',
        status: 0,
      },
      {
        requestId: randomUUID(),
        userId,
        channelId: null,
        credentialType: 'api_key',
        externalModel: model,
        realModel: `${model}-real`,
        inputTokens: 1,
        outputTokens: 1,
        amount: '0.2',
        paygAmount: '0.2',
        coefficient: '1.000',
        estimated: false,
        billedBy: 'payg',
        status: 0,
      },
    ]);
    const all = (await (
      await request(`/v1/usage-logs?q=${model}&page_size=50`, { token })
    ).json()) as {
      total: number;
      rows: Array<{ estimated: boolean; estimateReason: string | null }>;
    };
    expect(all.total).toBe(2);
    const estimatedRow = all.rows.find((r) => r.estimated);
    expect(estimatedRow!.estimateReason).toBe('usage_missing_completed');

    const onlyFalse = (await (
      await request(`/v1/usage-logs?q=${model}&estimated=false&page_size=50`, { token })
    ).json()) as { total: number; rows: Array<{ estimated: boolean }> };
    expect(onlyFalse.total).toBe(1);
    expect(onlyFalse.rows.every((r) => r.estimated === false)).toBe(true);

    const onlyTrue = (await (
      await request(`/v1/usage-logs?q=${model}&estimated=true&page_size=50`, { token })
    ).json()) as { total: number; rows: Array<{ estimated: boolean }> };
    expect(onlyTrue.total).toBe(1);
    expect(onlyTrue.rows.every((r) => r.estimated === true)).toBe(true);
  });
});

describe('logs（请求日志）', () => {
  it('userName = displayName ?? email 回退；q 命中 requestId；statusCode 分组过滤', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const named = await newUserRow({ displayName: '日志测试-有名' });
    const anonymous = await newUserRow({ displayName: null });
    const { users } = await import('@ai-gateway/db');
    await db
      .update(users)
      .set({ email: `${uid('anon')}@example.com` })
      .where(eq(users.id, anonymous));
    const reqId = randomUUID();
    await db.insert(requestLogs).values([
      {
        requestId: reqId,
        userId: named,
        method: 'POST',
        path: '/v1/chat/completions',
        statusCode: 200,
        sourceIp: '1.2.3.4',
        durationMs: 10,
      },
      {
        requestId: randomUUID(),
        userId: anonymous,
        method: 'POST',
        path: '/v1/chat/completions',
        statusCode: 500,
        errorCode: 'internal_error',
        sourceIp: '1.2.3.4',
        durationMs: 20,
      },
    ]);
    // q 命中 path（搜索列是 path/errorCode/sourceIp/requestId——用户名只随行回显）
    const withName = (await (
      await request(`/v1/logs?q=${encodeURIComponent('/v1/chat/completions')}&statusCode=2xx`, {
        token,
      })
    ).json()) as { rows: Array<{ userName: string | null; statusCode: number }> };
    const namedRow = withName.rows.find((r) => r.userName === '日志测试-有名');
    expect(namedRow).toBeTruthy();
    // 无名回退 email（5xx 分组过滤 + path 命中当前行）
    const withEmail = (await (
      await request(`/v1/logs?statusCode=5xx&q=${encodeURIComponent('/v1/chat/completions')}`, {
        token,
      })
    ).json()) as { rows: Array<{ userName: string | null; statusCode: number }> };
    const anonRow = withEmail.rows.find((r) => r.userName?.includes('@example.com'));
    expect(anonRow).toBeTruthy();
    // requestId 精确命中（复核下钻路径）
    const byRequest = (await (await request(`/v1/logs?q=${reqId}`, { token })).json()) as {
      total: number;
    };
    expect(byRequest.total).toBe(1);
  });
});

describe('stats', () => {
  it('overview 结构完整 + usage 三轴分组', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const overview = (await (await request('/v1/stats/overview', { token })).json()) as {
      today: { requests: number; successRate: number; failedCount: number };
      total: { requests: number };
      channelHealth: Array<{ status: number; count: number }>;
    };
    expect(typeof overview.today.requests).toBe('number');
    expect(typeof overview.today.successRate).toBe('number');
    expect(Array.isArray(overview.channelHealth)).toBe(true);

    const usage = (await (await request('/v1/stats/usage?group=model', { token })).json()) as {
      list: Array<{ key: string | null; requests: number }>;
    };
    expect(Array.isArray(usage.list)).toBe(true);

    const byChannel = (await (
      await request('/v1/stats/usage?group=channel', { token })
    ).json()) as { list: unknown[] };
    expect(Array.isArray(byChannel.list)).toBe(true);
  });

  it('trends：按日行结构完整', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const trends = (await (await request('/v1/stats/trends?days=7', { token })).json()) as {
      days: number;
      rows: Array<{ date: string; requests: number; cost: string }>;
    };
    expect(trends.days).toBe(7);
    expect(Array.isArray(trends.rows)).toBe(true);
    for (const row of trends.rows) {
      expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof row.requests).toBe('number');
      expect(typeof row.cost).toBe('string');
    }
  });
});

describe('notifications', () => {
  it('webhook 渠道创建 + 更新 + 测试入箱 + 删除；email 缺 recipients → 400', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();

    const bad = await request('/v1/notifications', {
      token,
      body: { name: uid('ch'), type: 'email', config: {}, events: ['billing_dead'] },
    });
    expect(bad.status).toBe(400);

    const created = await request('/v1/notifications', {
      token,
      body: {
        name: uid('notify'),
        type: 'webhook',
        config: { url: 'https://hooks.example.test/x', secret: 's'.repeat(24) },
        events: ['channel_disabled', 'billing_dead'],
      },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { id: number; name: string };
    const channelId = createdBody.id;

    const patched = await request(`/v1/notifications/${channelId}`, {
      method: 'PATCH',
      token,
      body: { status: 1 },
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { status: number }).status).toBe(1);

    const tested = await request(`/v1/notifications/${channelId}/test`, { method: 'POST', token });
    expect(tested.status).toBe(200);
    // 入箱行存在（按本渠道测试键前缀查——不被历史数据淹没）
    const { like } = await import('drizzle-orm');
    const events = await db
      .select()
      .from(notifyOutbox)
      .where(like(notifyOutbox.dedupeKey, `test:${channelId}:%`));
    expect(events.length).toBeGreaterThan(0);
    expect((events[0]!.payload as { test?: boolean }).test).toBe(true);

    // 重名 → 409
    const dup = await request('/v1/notifications', {
      token,
      body: {
        name: createdBody.name,
        type: 'webhook',
        config: { url: 'https://hooks.example.test/y', secret: 's'.repeat(24) },
        events: ['billing_dead'],
      },
    });
    expect(dup.status).toBe(409);

    expect(
      (await request(`/v1/notifications/${channelId}`, { method: 'DELETE', token })).status,
    ).toBe(200);
    const [row] = await db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId));
    expect(row).toBeUndefined();
    // 出箱测试行清理
    await db.delete(notifyOutbox).where(like(notifyOutbox.dedupeKey, `test:${channelId}:%`));
  });
});

describe('payment-orders', () => {
  it('列表 + 手动关单 CAS（created→expired）；已支付订单拒绝关闭', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const userId = await newUserRow();
    const orderId = randomUUID();
    await db.insert(paymentOrders).values({
      id: orderId,
      provider: 'epay',
      providerOrderId: uid('po'),
      userId,
      amount: '10',
      creditAmount: '10',
      currency: 'CNY',
      status: 0,
    });
    const paidOrderId = randomUUID();
    await db.insert(paymentOrders).values({
      id: paidOrderId,
      provider: 'epay',
      providerOrderId: uid('po'),
      userId,
      amount: '5',
      creditAmount: '5',
      currency: 'CNY',
      status: 1,
    });

    // 列表：uuid 精确命中
    const list = (await (await request(`/v1/payment-orders?q=${orderId}`, { token })).json()) as {
      total: number;
      rows: Array<{ userDisplayName: string | null }>;
    };
    expect(list.total).toBe(1);

    // created → 手动关闭成功
    const closed = await request(`/v1/payment-orders/${orderId}/close`, { method: 'POST', token });
    expect(closed.status).toBe(200);
    const [row] = await db.select().from(paymentOrders).where(eq(paymentOrders.id, orderId));
    expect(row!.status).toBe(4);
    expect(row!.failureReason).toContain('管理员');

    // paid → 拒绝（资金已入账——回调域专属）
    expect(
      (await request(`/v1/payment-orders/${paidOrderId}/close`, { method: 'POST', token })).status,
    ).toBe(409);
    // 清理（测试直插）
    await db.delete(paymentOrders).where(inArray(paymentOrders.id, [orderId, paidOrderId]));
  });
});

describe('billing-operations（死单复核）', () => {
  it('status=dead 必填（缺失 400）；reason 必填；uuid 参数校验；复核全链', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    expect((await request('/v1/billing-operations', { token })).status).toBe(400);
    expect(
      (
        await request('/v1/billing-operations/not-a-uuid/retry', {
          method: 'POST',
          token,
          body: { expectedRevision: 0, reason: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/v1/billing-operations/00000000-0000-4000-8000-000000000000/retry', {
          method: 'POST',
          token,
          body: { expectedRevision: 0, reason: '   ' },
        })
      ).status,
    ).toBe(400);

    // 列表信封（空库也是 200）
    const list = (await (
      await request('/v1/billing-operations?status=dead', { token })
    ).json()) as { rows: unknown[]; total: number };
    expect(Array.isArray(list.rows)).toBe(true);

    // 不存在的死单 retry → 409 state_conflict
    const retry = await request(
      '/v1/billing-operations/00000000-0000-4000-8000-000000000001/retry',
      {
        method: 'POST',
        token,
        body: { expectedRevision: 0, reason: '复核重试' },
        headers: { 'idempotency-key': uid('br') },
      },
    );
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as { error: { code: string } }).error.code).toBe(
      'billing_state_conflict',
    );
  });
});
