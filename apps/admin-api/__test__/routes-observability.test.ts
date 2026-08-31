import { describe, expect, it } from 'vitest';
import { createAdminApp } from '../src/app';
import { authHeader, fakeDeps } from './helpers';

/**
 * 观测域契约:recent 过滤与信封 / topology hours 钳位 / 审计与请求日志列表口径。
 */

describe('GET /v1/tracing/*', () => {
  it('recent:errorsOnly 过滤 + 信封 rows/total/page/pageSize', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          traces: {
            recent: async () => ({ rows: [{ traceId: 't1' }], total: 1 }),
          } as never,
        },
      }),
    );
    const res = await app.request(
      '/v1/tracing/recent?errorsOnly=true&service=gateway&page_size=50',
      {
        headers: authHeader(),
      },
    );
    expect(await res.json()).toEqual({
      rows: [{ traceId: 't1' }],
      total: 1,
      page: 1,
      pageSize: 50,
    });
  });

  it('detail/by-request/topology(hours 钳位)/stats 信封', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          traces: {
            recent: async () => ({ rows: [], total: 0 }),
            traceDetail: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            byRequest: async () => ({ spans: [], services: [], startMs: 0, durationMs: 0 }),
            topology: async () => [] as never,
            stats: async () => ({ totalSpans: 0 }) as never,
          } as never,
        },
      }),
    );
    expect(
      await (await app.request('/v1/tracing/traces/t1', { headers: authHeader() })).json(),
    ).toMatchObject({ spans: [] });
    expect(
      await (await app.request('/v1/tracing/by-request/req-1', { headers: authHeader() })).json(),
    ).toMatchObject({ spans: [] });
    const clamped = await app.request('/v1/tracing/topology?hours=9999', { headers: authHeader() });
    expect(await clamped.json()).toEqual({ hours: 168, channels: [] });
    const stats = await app.request('/v1/tracing/stats', { headers: authHeader() });
    expect(await stats.json()).toEqual({ storage: { totalSpans: 0 } });
  });
});

describe('GET /v1/audit-logs 与 /v1/logs', () => {
  it('审计列表:q/sort 白名单/adminSubject 恒 null(D5)', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          audit: {
            list: async () => ({
              rows: [
                {
                  id: 1,
                  adminId: 7,
                  actor: 'admin',
                  action: 'channel.update',
                  targetType: 'channel',
                  targetId: '2',
                  detail: { k: 1 },
                  createdAt: new Date('2026-08-01T00:00:00Z'),
                },
              ],
              total: 1,
            }),
          },
        },
      }),
    );
    const res = await app.request('/v1/audit-logs?q=channel&action=x', { headers: authHeader() });
    expect(await res.json()).toMatchObject({
      rows: [{ id: 1, adminSubject: null, action: 'channel.update' }],
      total: 1,
    });
    const bad = await app.request('/v1/audit-logs?sort_by=passwordHash', { headers: authHeader() });
    expect(bad.status).toBe(400);
  });

  it('请求日志:statusCode 分组与时间过滤透传;apiKeyId 恒 null(D5)', async () => {
    const app = createAdminApp(
      fakeDeps({
        observability: {
          requestLogs: {
            list: async () => ({
              rows: [
                {
                  id: 1,
                  requestId: 'r1',
                  userId: 42,
                  userName: 'U',
                  method: 'POST',
                  path: '/v1/chat/completions',
                  statusCode: 200,
                  errorCode: null,
                  sourceIp: '10.0.0.1',
                  durationMs: 120,
                  requestSummary: { model: 'gpt-x', stream: false },
                  attempts: 2,
                  channels: ['openrouter', '腾讯云'],
                  createdAt: new Date('2026-08-01T00:00:00Z'),
                },
              ],
              total: 1,
            }),
          },
        },
      }),
    );
    const res = await app.request('/v1/logs?statusCode=5xx', { headers: authHeader() });
    expect(await res.json()).toMatchObject({
      rows: [
        {
          id: 1,
          apiKeyId: null,
          requestSummary: { model: 'gpt-x' },
          attempts: 2,
          channels: ['openrouter', '腾讯云'],
        },
      ],
      total: 1,
    });
  });
});
