import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { like, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '@ai-gateway/db';
import {
  users,
  providers,
  channels,
  modelMappings,
  rateCards,
  rateCardCoefficients,
  plans,
  admins,
  requestLogs,
} from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { providerAdminRoutes } from '../providers.js';
import { channelAdminRoutes } from '../channels.js';
import { modelAdminRoutes } from '../models.js';
import { rateCardAdminRoutes } from '../rate-cards.js';
import { planAdminRoutes } from '../plans.js';
import { billingOperationsRoutes } from '../billing-operations.js';
import { logAdminRoutes } from '../logs.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * R10 列表接口统一回归（api-contract §4）：
 *   - 所有记录列表统一 {list,total,page,page_size} envelope
 *     （providers/channels/models/rate-cards/plans 由 {list,total} 升级）
 *   - ?q= 文本搜索（ilike；% _ 按字面匹配）
 *   - ?sort_by=&order= 白名单排序；默认时间倒序（无 created_at 的表按 id desc）
 *   - 白名单外 sort_by → 400 INVALID_SORT_FIELD（不静默回退）
 * 数据纪律：名称前缀 lq10-，清理只删该前缀。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
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
    await db.delete(channels).where(like(channels.name, 'lq10-%'));
    await db.delete(modelMappings).where(like(modelMappings.externalName, 'lq10-%'));
    await db.delete(providers).where(like(providers.name, 'lq10-%'));
    await db
      .delete(rateCardCoefficients)
      .where(
        sql`${rateCardCoefficients.rateCardId} in (select id from ${rateCards} where name like 'lq10-\%')`,
      );
    await db.delete(rateCards).where(like(rateCards.name, 'lq10-%'));
    await db.delete(plans).where(like(plans.name, 'lq10-%'));
  }
  await db.$client.end().catch(() => {});
});

const marker = () => `lq10-${Date.now()}`;

describe('R10: providers 列表统一', () => {
  it('envelope + q 搜索 + sort 白名单（非法 400）', async (context) => {
    if (!connected) return context.skip();
    const m = marker();
    const app = makeAdminTestApp({ '/providers': providerAdminRoutes(makeServices(db)) });
    const create = (name: string) =>
      app.request('/api/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl: `https://${m}.example.com` }),
      });
    expect((await create(`${m}-alpha`)).status).toBe(201);
    expect((await create(`${m}-beta`)).status).toBe(201);

    // envelope：list/total/page/page_size 齐全
    const all = (await (
      await app.request(`/api/admin/providers?q=${m}`)
    ).json()) as { list: Array<{ name: string }>; total: number; page: number; page_size: number };
    expect(all.total).toBe(2);
    expect(all.page).toBe(1);
    expect(all.page_size).toBe(20);
    expect(all.list).toHaveLength(2);

    // q 精确到单条
    const one = (await (
      await app.request(`/api/admin/providers?q=${m}-alpha`)
    ).json()) as { list: string[]; total: number };
    expect(one.total).toBe(1);

    // sort_by 白名单 + asc
    const sorted = (await (
      await app.request(`/api/admin/providers?q=${m}&sort_by=name&order=asc&page_size=10`)
    ).json()) as { list: Array<{ name: string }> };
    expect(sorted.list[0]!.name).toBe(`${m}-alpha`);
    const sortedDesc = (await (
      await app.request(`/api/admin/providers?q=${m}&sort_by=name&order=desc&page_size=10`)
    ).json()) as { list: Array<{ name: string }> };
    expect(sortedDesc.list[0]!.name).toBe(`${m}-beta`);

    // 白名单外 → 400 + 错误码
    const bad = await app.request(`/api/admin/providers?sort_by=password`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('INVALID_SORT_FIELD');

    // q 中的 % 是字面字符（不当作通配）
    const literal = (await (
      await app.request(`/api/admin/providers?q=${m}%25alpha`)
    ).json()) as { total: number };
    expect(literal.total).toBe(0);
  });
});

describe('R10: models / channels / rate-cards / plans 列表统一', () => {
  it('models：envelope + q(externalName) + channelIds 回显仍在', async (context) => {
    if (!connected) return context.skip();
    const m = marker();
    await db.insert(modelMappings).values([
      {
        externalName: `${m}-m-a`,
        realModel: `${m}-real-a`,
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.5',
      },
      {
        externalName: `${m}-m-b`,
        realModel: `${m}-real-b`,
        inputPrice: '1',
        outputPrice: '2',
        cacheInputPrice: '0.5',
      },
    ]);
    const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
    const body = (await (
      await app.request(`/api/admin/models?q=${m}-m-b`)
    ).json()) as { list: Array<{ channelIds: number[] }>; total: number; page: number; page_size: number };
    expect(body.total).toBe(1);
    expect(body.list[0]!.channelIds).toEqual([]);
    const bad = await app.request('/api/admin/models?sort_by=hacker');
    expect(bad.status).toBe(400);
  });

  it('channels：envelope + q(渠道名) + 绑定模型/已消耗字段仍在', async (context) => {
    if (!connected) return context.skip();
    const m = marker();
    const app = makeAdminTestApp({ '/channels': channelAdminRoutes(makeServices(db)) });
    const [prov] = await db
      .insert(providers)
      .values({ name: `${m}-prov`, baseUrl: `https://${m}.example.com` })
      .returning({ id: providers.id });
    const providerId = prov!.id;
    const ch = await app.request('/api/admin/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId, name: `${m}-chan-a`, apiKey: 'sk-lq10' }),
    });
    expect(ch.status).toBe(201);

    const body = (await (
      await app.request(`/api/admin/channels?q=${m}-chan`)
    ).json()) as {
      list: Array<{ boundModels: unknown[]; upstreamConsumed: string; providerName: string }>;
      total: number;
      page: number;
      page_size: number;
    };
    expect(body.total).toBe(1);
    expect(body.list[0]!.boundModels).toEqual([]);
    expect(body.list[0]!.upstreamConsumed).toBe('0');
    expect(body.list[0]!.providerName).toBe(`${m}-prov`);
  });

  it('rate-cards：envelope + q(name)；plans：envelope + 默认 id desc + q', async (context) => {
    if (!connected) return context.skip();
    const m = marker();
    const rcApp = makeAdminTestApp({ '/rate-cards': rateCardAdminRoutes(makeServices(db)) });
    const rc1 = await rcApp.request('/api/admin/rate-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${m}-card-a`, coefficient: 1 }),
    });
    expect(rc1.status).toBe(201);
    await rcApp.request('/api/admin/rate-cards', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${m}-card-b`, coefficient: 1.5 }),
    });
    const rcBody = (await (
      await rcApp.request(`/api/admin/rate-cards?q=${m}-card-b`)
    ).json()) as { list: Array<{ coefficient: string }>; total: number; page: number; page_size: number };
    expect(rcBody.total).toBe(1);
    expect(rcBody.list[0]!.coefficient).toBe('1.500');
    expect(rcBody.page).toBe(1);

    await db.insert(plans).values([
      { name: `${m}-plan-a`, price: '10', periodDays: 30, quotaAmount: '100' },
      { name: `${m}-plan-b`, price: '20', periodDays: 30, quotaAmount: '200' },
    ]);
    const planApp = makeAdminTestApp({ '/plans': planAdminRoutes(makeServices(db)) });
    const planBody = (await (
      await planApp.request(`/api/admin/plans?q=${m}`)
    ).json()) as { list: Array<{ id: number; name: string }>; total: number };
    expect(planBody.total).toBe(2);
    // plans 无 created_at → 默认 id desc（新建在前）
    expect(planBody.list[0]!.name).toBe(`${m}-plan-b`);
    const priceAsc = (await (
      await planApp.request(`/api/admin/plans?q=${m}&sort_by=price&order=asc`)
    ).json()) as { list: Array<{ name: string }> };
    expect(priceAsc.list[0]!.name).toBe(`${m}-plan-a`);
  });

  it('billing-operations：status 必填；标准 envelope', async (context) => {
    if (!connected) return context.skip();
    const [adm] = await db
      .select({ id: admins.id })
      .from(admins)
      .where(eq(admins.email, 'admin@ai-gateway.local'))
      .limit(1);
    const app = makeAdminTestApp(
      { '/billing-operations': billingOperationsRoutes(makeServices(db)) },
      { adminId: adm?.id ?? 1 },
    );
    const missing = await app.request('/api/admin/billing-operations');
    expect(missing.status).toBe(400);
    const ok = await app.request('/api/admin/billing-operations?status=dead&page=1&page_size=5');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { list: unknown[]; total: number; page: number; page_size: number };
    expect(body.page).toBe(1);
    expect(body.page_size).toBe(5);
    expect(Array.isArray(body.list)).toBe(true);
  });
});

describe('R10: logs 搜索覆盖 request_id', () => {
  it('q=uuid 能命中（计费复核单最自然的下钻：拿 request_id 查请求日志）', async (context) => {
    if (!connected) return context.skip();
    const rid = randomUUID();
    await db.insert(requestLogs).values({
      requestId: rid,
      method: 'POST',
      path: '/lq10-reqid-probe',
      statusCode: 503,
      errorCode: 'http_503',
      durationMs: 100,
      sourceIp: '127.0.0.1',
    });
    try {
      const app = makeAdminTestApp({ '/logs': logAdminRoutes(makeServices(db)) });
      const body = (await (
        await app.request(`/api/admin/logs?q=${rid}`)
      ).json()) as { list: Array<{ requestId: string }>; total: number };
      expect(body.total).toBe(1);
      expect(body.list[0]!.requestId).toBe(rid);
    } finally {
      await db.delete(requestLogs).where(eq(requestLogs.requestId, rid));
    }
  });
});
