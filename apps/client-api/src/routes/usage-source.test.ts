import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { usageLogs, users, apiKeys, apps } from '@ai-gateway/db/schema';
import type { ClientEnv } from '@ai-gateway/identity';
import { panelRoutes } from './panel.js';

/**
 * GET /api/usage 来源展示：key 调用 → keyName；app 调用（jwt）→ appName。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

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

function makeApp(userId: number): Hono<ClientEnv> {
  const app = new Hono<ClientEnv>();
  app.use('/api/*', async (c, next) => {
    c.set('session', { userId });
    await next();
  });
  app.route('/', panelRoutes(db));
  return app;
}

describe('GET /api/usage 来源（keyName / appName）', () => {
  it('key 调用显示 key 名称，app 调用（jwt）显示 app 名称', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [me] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__us_me_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [key] = await db
      .insert(apiKeys)
      .values({ keyHash: randomUUID(), keyPreview: 'ag_****test', userId: me.id, name: '我的Key' })
      .returning({ id: apiKeys.id });
    const [app] = await db
      .insert(apps)
      .values({ appId: `app_${s}`, userId: me.id, clientId: `cid_${s}`, clientSecretHash: randomUUID(), name: '我的应用' })
      .returning({ id: apps.id });

    const ids: number[] = [];
    try {
      const [u1] = await db
        .insert(usageLogs)
        .values({
          requestId: randomUUID(),
          userId: me.id,
          apiKeyId: key.id,
          credentialType: 'key',
          externalModel: 'm',
          realModel: 'm',
          coefficient: '1',
          billedBy: 'payg',
          amount: '1',
        })
        .returning({ id: usageLogs.id });
      ids.push(u1.id);
      const [u2] = await db
        .insert(usageLogs)
        .values({
          requestId: randomUUID(),
          userId: me.id,
          appId: app.id,
          credentialType: 'jwt',
          externalModel: 'm',
          realModel: 'm',
          coefficient: '1',
          billedBy: 'payg',
          amount: '1',
        })
        .returning({ id: usageLogs.id });
      ids.push(u2.id);

      const res = await makeApp(me.id).request('/api/usage?page=1&page_size=10');
      const json = (await res.json()) as {
        list: Array<{ id: number; credentialType: string; keyName: string | null; appName: string | null }>;
      };
      const r1 = json.list.find((r) => r.id === u1.id);
      const r2 = json.list.find((r) => r.id === u2.id);
      // eslint-disable-next-line no-console
      console.log('[usage-source] key 调用 →', r1?.credentialType, r1?.keyName, '| app 调用 →', r2?.credentialType, r2?.appName);

      expect(r1?.credentialType).toBe('key');
      expect(r1?.keyName).toBe('我的Key');
      expect(r1?.appName).toBeNull();
      expect(r2?.credentialType).toBe('jwt');
      expect(r2?.appName).toBe('我的应用');
      expect(r2?.keyName).toBeNull();
    } finally {
      for (const id of ids) await db.delete(usageLogs).where(eq(usageLogs.id, id)).catch(() => {});
      await db.delete(apiKeys).where(eq(apiKeys.id, key.id)).catch(() => {});
      await db.delete(apps).where(eq(apps.id, app.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me.id)).catch(() => {});
    }
  });
});
