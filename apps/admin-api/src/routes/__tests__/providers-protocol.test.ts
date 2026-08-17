import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, providers } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { providerAdminRoutes } from '../providers.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 协议词表单一真相（词表统一回归）：
 * providers.protocol 只接受 ai 包适配器注册表键（SUPPORTED_PROTOCOLS = 'openai-compatible'）。
 * 治理前 UI 发送 'openai' / DB 默认 'openai-compatible'，请求时 unsupportedProtocolError——
 * 现在非法值在 admin-api 边界即被 400 拒绝（错误语义分级：可预期拒绝 ≠ 异常）。
 * 校验发生在 jsonBody（zod），不触库——400 用例无需 DB。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

const NAME_PREFIX = 'pvocab-';

async function cleanup(): Promise<void> {
  const rows = await db.select().from(providers);
  for (const p of rows) {
    if (p.name.startsWith(NAME_PREFIX)) await db.delete(providers).where(eq(providers.id, p.id));
  }
}

describe('providers 协议词表（SUPPORTED_PROTOCOLS 单一真相）', () => {
  it('非法协议（旧词表 openai_compatible / UI 旧值 openai / 任意串）→ 400（anthropic/gemini 等六协议族为合法词表）', async () => {
    const app = makeAdminTestApp({ '/providers': providerAdminRoutes(makeServices(db)) });
    for (const bad of ['openai', 'openai_compatible', 'made-up']) {
      const res = await app.request('/api/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${NAME_PREFIX}${Date.now()}`, baseUrl: 'https://api.example.com/v1', protocol: bad }),
      });
      expect(res.status, `protocol=${bad} 应被 400 拒绝`).toBe(400);
    }
  });

  it('PATCH 非法协议 → 400（不存在的 id：校验在 zod 层先行，永不触真实数据）', async () => {
    const app = makeAdminTestApp({ '/providers': providerAdminRoutes(makeServices(db)) });
    const res = await app.request('/api/admin/providers/999999999', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'openai' }),
    });
    expect(res.status).toBe(400);
  });

  it('合法协议 openai-compatible → 201 且原样入库（无运行时翻译）', async () => {
    if (!connected) return it.skip('no DB');
    const name = `${NAME_PREFIX}${Date.now()}`;
    const app = makeAdminTestApp({ '/providers': providerAdminRoutes(makeServices(db)) });
    try {
      const res = await app.request('/api/admin/providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl: 'https://api.example.com/v1', protocol: 'openai-compatible' }),
      });
      expect(res.status).toBe(201);
      const created = (await res.json()) as { protocol: string };
      expect(created.protocol).toBe('openai-compatible');
      const [row] = await db.select().from(providers).where(eq(providers.name, name)).limit(1);
      expect(row?.protocol).toBe('openai-compatible');
    } finally {
      await cleanup();
    }
  });
});
