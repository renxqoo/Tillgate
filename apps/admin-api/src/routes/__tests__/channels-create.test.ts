import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, channels, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { channelAdminRoutes } from '../channels.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 渠道创建契约（集成）：POST /api/admin/channels。
 *
 * models 白名单的线上契约是 string[]（DB jsonb / GET 响应 / import 同口径）。
 * 2026-08 回归：管理端表单曾把逗号分隔字符串直传本接口（z.array 校验 4xx），
 * 「填了模型列表的创建必失败」。本测试钉住契约两端：数组放行并原样落库；
 * 字符串拒绝——字符串 → 数组的转换职责在 admin server action 边界，不在接口。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

let connected = false;
let providerId = 0;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
    const [provider] = await db
      .insert(providers)
      .values({
        // providers.name 是 varchar(32)，测试名必须留在这长度内
        name: `ct-${Date.now()}`,
        baseUrl: 'https://upstream.test',
      })
      .returning({ id: providers.id });
    providerId = provider!.id;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  if (connected) {
    await db.delete(channels).where(eq(channels.providerId, providerId));
    await db.delete(providers).where(eq(providers.id, providerId));
  }
  await db.$client.end().catch(() => {});
});

function app() {
  return makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
}

async function post(body: unknown): Promise<Response> {
  return app().request('/api/admin/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('渠道创建契约（集成）', () => {
  it('models 数组 → 201 且原样落库', async (context) => {
    if (!connected) return context.skip();
    const name = `ct-array-${Date.now()}`;
    const res = await post({
      providerId,
      name,
      apiKey: 'sk-test123',
      models: ['gpt-4o', 'claude-3-5-sonnet'],
      weight: 100,
      priority: 0,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { id: number };
    const row = await db.query.channels.findFirst({
      where: eq(channels.id, created.id),
      columns: { models: true },
    });
    expect(row?.models).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('models 逗号字符串 → 4xx（契约是数组；转换职责在调用方边界）', async (context) => {
    if (!connected) return context.skip();
    const res = await post({
      providerId,
      name: `ct-string-${Date.now()}`,
      apiKey: 'sk-test123',
      models: 'gpt-4o,claude-3-5-sonnet',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('models 缺省 → 201（不限白名单）', async (context) => {
    if (!connected) return context.skip();
    const res = await post({
      providerId,
      name: `ct-none-${Date.now()}`,
      apiKey: 'sk-test123',
    });
    expect(res.status).toBe(201);
  });
});
