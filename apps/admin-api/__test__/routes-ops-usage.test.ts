/**
 * 契约测试（usage/stats 族）：信封形状 / 过滤透传（estimated 显式布尔、
 * from/to/userId/model）/ 排序白名单外 400 / 词表外 400 / days 边界 /
 * hours 容错收口（NaN→24、越界钳 1..720——不 400）。
 * 业务语义本体在 observability 包测试;此处锁定 wire 形状与编排透传。
 */
import { describe, expect, it, vi } from 'vitest';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/** 冻结时钟(三组统计端点共用的注入面) */
const frozenNow = () => new Date('2026-08-23T10:00:00Z');

const usageRow = {
  id: 5,
  requestId: '019c0b7d-0000-7000-8000-00000000000a',
  userId: 21,
  userName: 'alice',
  credentialType: 'key',
  externalModel: 'gpt-4o',
  realModel: 'gpt-4o-real',
  channelId: 3,
  channelName: 'openai-main',
  inputTokens: 100,
  cachedInputTokens: 10,
  outputTokens: 50,
  units: 0,
  unitPrice: '0',
  pricingUnit: 'token',
  amount: '1.5',
  calculatedAmount: '1.5',
  planAmount: '1.0',
  paygAmount: '0.5',
  billedBy: 'payg',
  upstreamCost: '0.2',
  durationMs: 200,
  upstreamTtftMs: null,
  clientTtftMs: 300,
  stream: true,
  streamAborted: false,
  estimated: false,
  estimateReason: null,
  createdAt: new Date('2026-08-23T01:02:03.000Z'),
};

describe('usage-logs（P4）', () => {
  it('列表信封 + 过滤透传 + Date→ISO（estimated=false 显式传）', async () => {
    // 无渠道行：channel_id NULL（无渠道归属/渠道硬删 SET NULL）→ 渠道两字段透传 null
    const noChannelRow = { ...usageRow, id: 6, channelId: null, channelName: null };
    const adminList = vi.fn(async () => ({ rows: [usageRow, noChannelRow], total: 2 }));
    const app = createAdminApp(
      fakeDeps({
        observability: { usage: { adminList } },
      }),
    );
    const res = await app.request(
      '/v1/usage-logs?estimated=false&userId=21&model=gpt-4o&from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z&q=gpt&page=2&page_size=10&sort_by=amount&order=asc',
      { headers: authHeader() },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ total: 2, page: 2, pageSize: 10 });
    const rows = body.rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      createdAt: '2026-08-23T01:02:03.000Z',
      amount: '1.5',
      channelId: 3,
      channelName: 'openai-main',
    });
    expect(rows[1]).toMatchObject({ channelId: null, channelName: null });
    expect(adminList).toHaveBeenCalledWith({
      q: 'gpt',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T00:00:00.000Z'),
      userId: 21,
      model: 'gpt-4o',
      estimated: false, // 'false' 字符串 → 布尔 false（coerce 陷阱回归锁定）
      sortBy: 'amount',
      order: 'asc',
      limit: 10,
      offset: 10,
    });
  });

  it('estimated 词表外 400;排序白名单外 400（invalid_sort_field）', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: { usage: { adminList: vi.fn(async () => ({ rows: [], total: 0 })) } },
      }),
    );
    const badEstimated = await app.request('/v1/usage-logs?estimated=yes', {
      headers: authHeader(),
    });
    expect(badEstimated.status).toBe(400);
    expect(await badEstimated.json()).toMatchObject({ error: { code: 'http.validation_failed' } });

    const badSort = await app.request('/v1/usage-logs?sort_by=userName', {
      headers: authHeader(),
    });
    expect(badSort.status).toBe(400);
    expect(await badSort.json()).toMatchObject({ error: { code: 'admin.invalid_sort_field' } });
  });
});

describe('usage-logs（P4）', () => {
  it('裸调用零过滤(可选展开全走 undefined 侧)', async () => {
    const adminList = vi.fn(async () => ({ rows: [], total: 0 }));
    const app = createAdminApp(fakeDeps({ observability: { usage: { adminList } } }));
    const res = await app.request('/v1/usage-logs', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(adminList).toHaveBeenCalledWith({
      sortBy: 'createdAt',
      order: 'desc',
      limit: 20,
      offset: 0,
    });
  });
});

describe('stats 族（P4）', () => {
  it('overview:now 注入透传 + 信封原样', async () => {
    const overview = vi.fn(async () => ({
      today: {
        requests: 7,
        inputTokens: 123,
        outputTokens: 456,
        cost: '1.23',
        successCount: 6,
        failedCount: 1,
        successRate: 85.7,
      },
      total: { cost: '99', requests: 1000 },
      channelHealth: [{ status: 0, count: 3 }],
    }));
    const app = createAdminApp(
      fakeDeps({ observability: { usage: { overview } }, now: frozenNow }),
    );
    const res = await app.request('/v1/stats/overview', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ today: { successRate: 85.7 } });
    expect(overview).toHaveBeenCalledWith({ now: frozenNow() });
  });

  it('usage 分组:group 词表内透传 + from/to;词表外 400;缺省 model', async () => {
    const groups = vi.fn(async () => ({ list: [] }));
    const app = createAdminApp(fakeDeps({ observability: { usage: { groups } } }));
    const ok = await app.request('/v1/stats/usage?group=channel&from=2026-08-01T00:00:00.000Z', {
      headers: authHeader(),
    });
    expect(ok.status).toBe(200);
    expect(groups).toHaveBeenCalledWith({
      group: 'channel',
      from: new Date('2026-08-01T00:00:00.000Z'),
    });

    await app.request('/v1/stats/usage', { headers: authHeader() });
    expect(groups).toHaveBeenLastCalledWith({ group: 'model' });
    await app.request(
      '/v1/stats/usage?group=user&from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z',
      { headers: authHeader() },
    );
    expect(groups).toHaveBeenLastCalledWith({
      group: 'user',
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T00:00:00.000Z'),
    });

    const bad = await app.request('/v1/stats/usage?group=tenant', { headers: authHeader() });
    expect(bad.status).toBe(400);
  });

  it('trends:days 边界（缺省 14/上限 90/词表外 400）', async () => {
    const trends = vi.fn(async () => ({ days: 14, rows: [] }));
    const app = createAdminApp(fakeDeps({ observability: { usage: { trends } } }));
    await app.request('/v1/stats/trends', { headers: authHeader() });
    expect(trends).toHaveBeenLastCalledWith({ days: 14, now: expect.any(Date) });
    await app.request('/v1/stats/trends?days=90', { headers: authHeader() });
    expect(trends).toHaveBeenLastCalledWith({ days: 90, now: expect.any(Date) });
    const bad = await app.request('/v1/stats/trends?days=91', { headers: authHeader() });
    expect(bad.status).toBe(400);
    const zero = await app.request('/v1/stats/trends?days=0', { headers: authHeader() });
    expect(zero.status).toBe(400);
  });

  it('channel-ttft:hours 容错收口（NaN→24、>720 钳 720、<1 钳 1——不 400）', async () => {
    const channelTtft = vi.fn(async () => ({ rows: [] }));
    const app = createAdminApp(
      fakeDeps({ observability: { usage: { channelTtft } }, now: frozenNow }),
    );
    await app.request('/v1/analytics/channel-ttft?hours=abc', { headers: authHeader() });
    expect(channelTtft).toHaveBeenLastCalledWith({ hours: 24, now: frozenNow() });
    await app.request('/v1/analytics/channel-ttft?hours=99999', { headers: authHeader() });
    expect(channelTtft).toHaveBeenLastCalledWith({ hours: 720, now: frozenNow() });
    // '0' 是 falsy → 走 24 缺省(|| 语义);负数才触发下钳
    await app.request('/v1/analytics/channel-ttft?hours=0', { headers: authHeader() });
    expect(channelTtft).toHaveBeenLastCalledWith({ hours: 24, now: frozenNow() });
    await app.request('/v1/analytics/channel-ttft?hours=-5', { headers: authHeader() });
    expect(channelTtft).toHaveBeenLastCalledWith({ hours: 1, now: frozenNow() });
    // 缺省不带参数 → 24
    await app.request('/v1/analytics/channel-ttft', { headers: authHeader() });
    expect(channelTtft).toHaveBeenLastCalledWith({ hours: 24, now: frozenNow() });
  });
});
