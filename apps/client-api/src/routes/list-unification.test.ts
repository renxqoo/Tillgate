import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { like } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, apiKeys, plans } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { keyRoutes } from './keys.js';
import { planRoutes } from './plans.js';
import { orgRoutes } from './orgs.js';
import { makeClientTestApp, makeServices } from '../test/helpers.js';

/**
 * R10 列表接口统一回归（用户面）：
 *   - GET /api/keys?q= 真正过滤（此前前端发 q 后端不接收，搜索无效——本轮根治）
 *   - 白名单外 sort_by → 400；默认 createdAt desc
 *   - GET /api/plans、/api/orgs 升级为标准分页 envelope
 * 数据纪律：subject/name 前缀 lq10_，清理只删该前缀。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
);
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  if (connected) {
    await db.delete(apiKeys).where(like(apiKeys.name, 'lq10_%'));
    await db.delete(users).where(like(users.subject, '__lq10_%'));
    await db.delete(plans).where(like(plans.name, 'lq10_%'));
  }
  await db.$client.end().catch(() => {});
});

describe('R10: GET /api/keys 搜索根治', () => {
  it('q 过滤 name/remark；默认 createdAt desc；非法 sort_by 400', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__lq10_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    // 两条 key：同名前缀 + 不同 remark，逐条插入保证 createdAt 可区分
    await db.insert(apiKeys).values({
      userId: u!.id,
      keyHash: `lq10h1${s}`,
      keyPreview: 'ag_lq10__1',
      name: `lq10_k1_${s}`,
      remark: 'remark-alpha',
    });
    await new Promise((r) => setTimeout(r, 20));
    await db.insert(apiKeys).values({
      userId: u!.id,
      keyHash: `lq10h2${s}`,
      keyPreview: 'ag_lq10__2',
      name: `lq10_k2_${s}`,
      remark: 'remark-beta',
    });
    const app = makeClientTestApp(u!.id, { '/keys': keyRoutes(makeServices(db)) });

    // q 命中 name（旧实现忽略 q → 会返回 2 条）
    const byName = (await (
      await app.request(`/api/keys?q=lq10_k1_${s}`)
    ).json()) as { list: Array<{ name: string }>; total: number; page: number; page_size: number };
    expect(byName.total).toBe(1);
    expect(byName.list[0]!.name).toBe(`lq10_k1_${s}`);

    // q 命中 remark
    const byRemark = (await (
      await app.request(`/api/keys?q=remark-beta`)
    ).json()) as { total: number; list: Array<{ name: string }> };
    expect(byRemark.total).toBe(1);
    expect(byRemark.list[0]!.name).toBe(`lq10_k2_${s}`);

    // 默认 createdAt desc（后建在前）
    const all = (await (
      await app.request(`/api/keys?q=lq10_`)
    ).json()) as { list: Array<{ name: string }>; total: number };
    expect(all.total).toBe(2);
    expect(all.list[0]!.name).toBe(`lq10_k2_${s}`);

    // sort_by=name asc
    const sorted = (await (
      await app.request(`/api/keys?q=lq10_&sort_by=name&order=asc`)
    ).json()) as { list: Array<{ name: string }> };
    expect(sorted.list[0]!.name).toBe(`lq10_k1_${s}`);

    // 白名单外 → 400
    const bad = await app.request('/api/keys?sort_by=keyHash');
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SORT_FIELD');
  });
});

describe('R10: plans / orgs 分页 envelope', () => {
  it('plans：{list,total,page,page_size}；sortOrder asc 排序可用', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    await db.insert(plans).values([
      { name: `lq10_pA_${s}`, price: '10', periodDays: 30, quotaAmount: '100', sortOrder: 1 },
      { name: `lq10_pB_${s}`, price: '20', periodDays: 30, quotaAmount: '200', sortOrder: 2 },
    ]);
    const app = makeClientTestApp(1, { '/plans': planRoutes(makeServices(db)) });
    const res = await app.request(`/api/plans?q=lq10_p&sort_by=sortOrder&order=asc`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      list: Array<{ name: string; kind: string }>;
      total: number;
      page: number;
      page_size: number;
    };
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.list[0]!.name).toBe(`lq10_pA_${s}`);
    expect(body.list.every((p) => p.kind === 'subscription')).toBe(true);
  });

  it('orgs：{list,total,page,page_size}（无组织用户 → 空 list）', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__lq10_o_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const app = makeClientTestApp(u!.id, { '/orgs': orgRoutes(makeServices(db)) });
    const res = await app.request('/api/orgs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { list: unknown[]; total: number; page: number; page_size: number };
    expect(body.total).toBe(0);
    expect(body.list).toEqual([]);
    expect(body.page_size).toBe(20);
  });
});
