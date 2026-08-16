import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { modelAdminRoutes } from '../models.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * A1 红测：模型价格/contextLength 数值域必须有限且有上界。
 * z.coerce.number().min(0) 会放行 '1e999'→Infinity 与 1e21 —— 落库时
 * numeric(38,18)/bigint 溢出 → PG 22P02/22003 → 500。
 * 必须在 zod 层拒绝（400），MONEY_MAX 与 contextLength 上界见 http 包。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: modelMappings.id }).from(modelMappings).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

async function postModel(app: ReturnType<typeof makeAdminTestApp>, body: unknown): Promise<number> {
  const res = await app.request('/api/admin/models', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

describe('RED A1: POST /api/admin/models 数值域硬化 → 400（不得 500）', () => {
  it('inputPrice="1e999"（Infinity）与 1e21、contextLength=1e30 全部 400', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const app = makeAdminTestApp({ '/models': modelAdminRoutes(makeServices(db)) });
    const cases: Array<Record<string, unknown>> = [
      { externalName: `a1-inf-${s}`, realModel: 'm', inputPrice: '1e999' },
      { externalName: `a1-big-${s}`, realModel: 'm', inputPrice: 1e21 },
      { externalName: `a1-ctx-${s}`, realModel: 'm', contextLength: 1e30 },
    ];
    for (const body of cases) {
      const status = await postModel(app, body);
      expect(status, JSON.stringify(body)).toBe(400);
    }
    const created = await db.select({ id: modelMappings.id }).from(modelMappings).where(eq(modelMappings.externalName, `a1-inf-${s}`));
    expect(created.length).toBe(0);
  });
});
