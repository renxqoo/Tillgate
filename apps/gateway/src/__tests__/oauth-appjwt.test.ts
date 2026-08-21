/**
 * /oauth/token → app_jwt → /v1/models 全链闭环（签发与验证口径逐字段对齐）。
 * 锁定契约：app_id = apps 数字主键、iss/aud 显式——两端任一字段漂移都会令
 * 签出的令牌 100% 鉴权失败。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import { apps, users } from '@ai-gateway/db';
import { inArray } from 'drizzle-orm';
import type { Db } from '@ai-gateway/repository';
import { createApp } from '../app.js';

const JWT_SECRET = 'appjwt-test-secret-0123456789abcdef';
const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

const createdUsers: number[] = [];
const createdApps: number[] = [];
const clientId = `ci-${randomUUID().slice(0, 12)}`;
const clientSecret = `cs-${randomUUID()}`;

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'v2oj', subject: `v2oj-${randomUUID().slice(0, 8)}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  const [appRow] = await db
    .insert(apps)
    .values({
      appId: randomUUID().replace(/-/g, '').slice(0, 32),
      userId: user!.id,
      clientId,
      clientSecretHash: createHash('sha256').update(clientSecret).digest('hex'),
      name: 'v2oj-app',
      status: 0,
    })
    .returning({ id: apps.id });
  createdApps.push(appRow!.id);
});

afterAll(async () => {
  if (createdApps.length) await db.delete(apps).where(inArray(apps.id, createdApps));
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

function app() {
  return createApp({ db, oauth: { jwtSecret: JWT_SECRET, tokenTtlSeconds: 3_600 } });
}

describe('/oauth/token App JWT 闭环', () => {
  it('client_credentials 签发 → Bearer 调 /v1/models → 200（口径对齐不再断裂）', async () => {
    const tokenRes = await app().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
    });
    expect(tokenRes.status).toBe(200);
    const { access_token: token } = (await tokenRes.json()) as { access_token: string };
    expect(typeof token).toBe('string');

    const modelsRes = await app().request('/v1/models', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(modelsRes.status).toBe(200); // 口径对齐放行（app_id 非数字 + 缺 iss/aud 则 500/401）
  }, 30_000);

  it('错 secret → 401（ipGuard 未装配不计数；装配后走爆破锁——守护在装配层测试）', async () => {
    const res = await app().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('Basic Auth 凭证传递同语义', async () => {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await app().request('/oauth/token', {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    });
    expect(res.status).toBe(200);
  });
});
