import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { usageLogs, users, apiKeys, apps } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { usageRoutes } from './usage.js';
import { makeClientTestApp, makeServices } from '../test/helpers.js';

/**
 * GET /api/usage 来源展示：key 调用 → keyName；app 调用（jwt）→ appName。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

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
  await db.$client.end().catch(() => {});
});

async function insertUsage(
  userId: number,
  model: string,
  opts: { apiKeyId?: number; appId?: number; credentialType?: string } = {},
): Promise<number> {
  const [r] = await db
    .insert(usageLogs)
    .values({
      requestId: randomUUID(),
      userId,
      credentialType: opts.credentialType ?? (opts.apiKeyId !== undefined ? 'key' : 'jwt'),
      externalModel: model,
      realModel: model,
      coefficient: '1.000',
      billedBy: 'payg',
      amount: '1.00',
      inputTokens: 10,
      outputTokens: 5,
      apiKeyId: opts.apiKeyId,
      appId: opts.appId,
    })
    .returning({ id: usageLogs.id });
  return r!.id;
}

describe('GET /api/usage 来源展示（keyName / appName）', () => {
  it('key 调用 → keyName = key 名称；app 调用 → appName = app 名称', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [me] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__usrc_me_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [k] = await db
      .insert(apiKeys)
      .values({ keyHash: randomUUID(), keyPreview: 'ag_****test', userId: me!.id, name: `测试Key_${s}` })
      .returning({ id: apiKeys.id });
    const [ap] = await db
      .insert(apps)
      .values({ appId: `app_${s}`, clientId: `app_${s}`, clientSecretHash: randomUUID(), userId: me!.id, name: `测试App_${s}` })
      .returning({ id: apps.id });
    const ids: number[] = [];
    try {
      ids.push(await insertUsage(me!.id, 'm1', { apiKeyId: k!.id }));
      ids.push(await insertUsage(me!.id, 'm2', { appId: ap!.id }));

      const app = makeClientTestApp(me!.id, { '/usage': usageRoutes(makeServices(db)) });
      const res = await app.request('/api/usage?page=1&page_size=10');
      const json = (await res.json()) as {
        list: Array<{ id: number; keyName: string | null; appName: string | null }>;
      };

      const keyRow = json.list.find((r) => r.id === ids[0]);
      const appRow = json.list.find((r) => r.id === ids[1]);
      expect(keyRow?.keyName).toBe(`测试Key_${s}`);
      expect(keyRow?.appName).toBeNull();
      expect(appRow?.appName).toBe(`测试App_${s}`);
      expect(appRow?.keyName).toBeNull();
    } finally {
      for (const id of ids) await db.delete(usageLogs).where(eq(usageLogs.id, id)).catch(() => {});
      await db.delete(apiKeys).where(eq(apiKeys.id, k!.id)).catch(() => {});
      await db.delete(apps).where(eq(apps.id, ap!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me!.id)).catch(() => {});
    }
  });
});
