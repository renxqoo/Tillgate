import { describe, expect, it, vi } from 'vitest';
import { defaultRoutingPolicy } from '@tillgate/inference';
import { createAdminApp } from '../src/app';
import { ADMIN_ID, authHeader, fakeDeps } from './helpers';

/**
 * 智能路由策略域契约：GET 未配置/已配置分支、PUT 校验（schema 边界 + refine +
 * note 长度）、观测 windowMs 容错回落、save 的审计 ctx 透传。
 * 鉴权面（endpoint_permissions fail-closed / 超管短路）由 acl.test 独立覆盖。
 */

const noPolicy = async (): Promise<null> => null;
const savedStub = async (): Promise<{ version: string; savedAt: Date }> => ({
  version: '3',
  savedAt: new Date('2026-08-30T00:00:00Z'),
});
const noRows = async (): Promise<unknown[]> => [];

function routingApp(overrides: {
  get?: () => Promise<unknown>;
  /** input: never = 逆变放宽（各用例以具体调用面注入 vi.fn） */
  save?: (input: never) => Promise<{ version: string; savedAt: Date }>;
  channelsOverview?: (windowMs: number) => Promise<unknown[]>;
}) {
  return createAdminApp(
    fakeDeps({
      controlPlane: {
        routingPolicy: {
          get: overrides.get ?? noPolicy,
          save: overrides.save ?? savedStub,
          channelsOverview: overrides.channelsOverview ?? noRows,
        },
      },
    }),
  );
}

describe('GET /v1/routing-policy', () => {
  it('未配置：200 携带编译期缺省策略（前端表单初值契约）', async () => {
    const app = routingApp({ get: async () => null });
    const res = await app.request('/v1/routing-policy', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      unconfigured: boolean;
      policy: Record<string, unknown>;
    };
    expect(body.unconfigured).toBe(true);
    // 缺省锚点（值真相 = inference schema default；此处锁 wire 面形状不漂移）
    expect(body.policy).toMatchObject({
      scorers: { cacheAffinity: { enabled: true, boost: 3 }, budgetWatermark: { softRatio: 0.2 } },
      retry: { sameChannelMaxRetries: 3 },
    });
  });

  it('已配置：200 记录投影（version/note/updatedBy/updatedAt）', async () => {
    const app = routingApp({
      get: async () => ({
        id: 1,
        scope: 'global',
        version: '2',
        policy: defaultRoutingPolicy(),
        note: '初始策略',
        updatedBy: 'ops@tillgate',
        updatedAt: new Date('2026-08-29T12:00:00Z'),
      }),
    });
    const res = await app.request('/v1/routing-policy', { headers: authHeader() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.version).toBe('2');
    expect(body.note).toBe('初始策略');
    expect(body.updatedBy).toBe('ops@tillgate');
    expect(body.updatedAt).toBe('2026-08-29T12:00:00.000Z');
    expect(body.unconfigured).toBeUndefined();
  });
});

describe('PUT /v1/routing-policy', () => {
  it('合法 body：200 回执（version/savedAt）；save 收到策略体 + note + 审计 ctx（admin actor）', async () => {
    interface SaveCall {
      policy: Record<string, unknown>;
      note?: string;
      ctx: { actor: { kind: string; id: number }; requestId: string };
    }
    const save = vi.fn(async (_input: SaveCall) => ({
      version: '3',
      savedAt: new Date('2026-08-30T00:00:00Z'),
    }));
    const app = routingApp({ save });
    const policy = defaultRoutingPolicy();
    const res = await app.request('/v1/routing-policy', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ policy, note: '调参' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; savedAt: string };
    expect(body).toEqual({ ok: true, version: '3', savedAt: '2026-08-30T00:00:00.000Z' });
    expect(save).toHaveBeenCalledTimes(1);
    const input = save.mock.calls[0]?.[0];
    expect(input?.policy).toEqual(policy);
    expect(input?.note).toBe('调参');
    expect(input?.ctx.actor).toEqual({ kind: 'admin', id: ADMIN_ID });
    expect(input?.ctx.requestId).toBeTruthy();
  });

  it('字段越界（softRatio 0 < schema min 0.01）：400 validation_failed，context 定位字段路径', async () => {
    const save = vi.fn();
    const app = routingApp({ save });
    const policy = {
      ...defaultRoutingPolicy(),
      scorers: {
        ...defaultRoutingPolicy().scorers,
        budgetWatermark: { enabled: true, softRatio: 0 },
      },
    };
    const res = await app.request('/v1/routing-policy', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ policy }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; context?: Record<string, string> };
    };
    expect(body.error.code).toBe('http.validation_failed');
    expect(Object.keys(body.error.context ?? {})[0]).toContain(
      'body.policy.scorers.budgetWatermark.softRatio',
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('交叉校验（penalty base > max）：400 validation_failed（schema superRefine 路径）', async () => {
    const app = routingApp({});
    const base = defaultRoutingPolicy();
    const res = await app.request('/v1/routing-policy', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({
        policy: {
          ...base,
          penalty: { ...base.penalty, rateLimitBaseMs: 50_000, rateLimitMaxMs: 30_000 },
        },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; context?: Record<string, string> };
    };
    expect(body.error.code).toBe('http.validation_failed');
    expect(body.error.context).toHaveProperty('body.policy.penalty.rateLimitBaseMs');
  });

  it('note 超长（>255）：400 validation_failed', async () => {
    const app = routingApp({});
    const res = await app.request('/v1/routing-policy', {
      method: 'PUT',
      headers: { ...authHeader(), 'content-type': 'application/json' },
      body: JSON.stringify({ policy: defaultRoutingPolicy(), note: 'x'.repeat(256) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('http.validation_failed');
  });
});

describe('GET /v1/routing/channels-overview', () => {
  it('windowMs 缺省 1h；合法值透传；非法/越界回落 1h（观测参数永不 400）', async () => {
    const channelsOverview = vi.fn(async () => []);
    const app = routingApp({ channelsOverview });
    const base = { headers: authHeader() } as const;

    await app.request('/v1/routing/channels-overview', base);
    expect(channelsOverview).toHaveBeenLastCalledWith(3_600_000);

    await app.request('/v1/routing/channels-overview?windowMs=120000', base);
    expect(channelsOverview).toHaveBeenLastCalledWith(120_000);

    for (const bad of ['abc', '0', '-5', '999999999', '']) {
      await app.request(`/v1/routing/channels-overview?windowMs=${bad}`, base);
      expect(channelsOverview, `windowMs=${bad} 应回落缺省`).toHaveBeenLastCalledWith(3_600_000);
    }
  });

  it('行透传（rows 信封）', async () => {
    const row = {
      channelId: 1,
      channelName: 'ch',
      status: 0,
      priority: null,
      upstreamBudget: '100',
      upstreamRemaining: '70',
      requests: 10,
      failures: 1,
      avgDurationMs: 800,
      avgClientTtftMs: 250,
      cachedInputTokens: 1000,
      inputTokens: 4000,
    };
    const app = routingApp({ channelsOverview: async () => [row] });
    const res = await app.request('/v1/routing/channels-overview', { headers: authHeader() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rows: [row] });
  });
});
