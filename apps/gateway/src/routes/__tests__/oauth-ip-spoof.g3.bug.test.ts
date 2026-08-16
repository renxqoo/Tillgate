import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EphemeralRedis } from '@ai-gateway/http';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFileIntoProcess(): void {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
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
loadEnvFileIntoProcess();
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-jwt-7f3a9b2e5c1d4a8f6e0b';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

const { createEphemeralRedis } = await import('@ai-gateway/http');
const { eq } = await import('drizzle-orm');
const { Hono } = await import('hono');
const { createDb } = await import('@ai-gateway/db');
const dbSchema = await import('@ai-gateway/db/schema');
const users = dbSchema.users;
const apps = dbSchema.apps;
const oauthMod = await import('../oauth-token.js');
const oauthTokenRoutes = oauthMod.oauthTokenRoutes;
const { createOAuthService } = await import('../../services/auth/oauth-service.js');

/**
 * G3 实证：OAuth 爆破防护的 IP 维度可被 X-Forwarded-For 伪造绕过。
 *
 * oauth-token.ts:27,69：attemptKey = `oauth_attempts:${clientId}:${ip}`，
 * 而 ip 取自 `x-forwarded-for` 首段（客户端可控）。
 * 攻击者固定 clientId，每请求换一个伪造 IP → attemptKey 每次不同 → 永不锁定 → 无限爆破。
 *
 * 对比：gateway 静态 Key 鉴权的 brute-force-guard 按 keyHash 维度（不依赖 IP），不受此影响。
 *
 * 本测试：固定 client_id，连续发 OAUTH_MAX_ATTEMPTS(10) × 3 = 30 次错误密码，每次换伪造 XFF。
 * 期望（修复后）：达到阈值后锁定（429）。实际：因 key 每次不同，全部 401（永不锁）。
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
const db = createDb(DATABASE_URL);
let redis: EphemeralRedis;

let connected = false;
beforeAll(async () => {
  try {
    redis = await createEphemeralRedis();
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await redis?.close();
  await db.$client.end().catch(() => {});
});

async function setup(): Promise<{ userId: number; appId: number; clientId: string }> {
  const [u] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: 'g3-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      identityProvider: 'local',
      displayName: 'G3',
      balance: '1000',
    })
    .returning();
  const clientId = 'g3cli-' + Math.random().toString(36).slice(2, 10);
  const appIdField = 'g3app-' + Math.random().toString(36).slice(2, 10);
  const secretHash = createHash('sha256').update('right-secret').digest('hex');
  const [a] = await db
    .insert(apps)
    .values({
      appId: appIdField,
      userId: u!.id,
      clientId,
      clientSecretHash: secretHash,
      name: 'g3-app',
      status: 0,
    })
    .returning();
  return { userId: u!.id, appId: a!.id, clientId };
}
async function cleanup(userId: number, appId: number, clientId: string): Promise<void> {
  // 清 attempt key（修复后 key=oauth_attempts:{clientId}，无 IP 后缀；兼容旧格式 :* ）
  await redis.del(`oauth_attempts:${clientId}`);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `oauth_attempts:${clientId}:*`,
      'COUNT',
      100,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
  await db.delete(apps).where(eq(apps.id, appId));
  await db.delete(users).where(eq(users.id, userId));
}

function makeApp(): unknown {
  const app = new Hono();
  // 与 index.ts 挂载一致：/oauth/token + 路由 .post('/')
  app.route('/oauth/token', oauthTokenRoutes(createOAuthService(db, redis, process.env.JWT_SECRET!)));
  return app;
}

describe('G3 — OAuth 爆破防护 IP 可伪造（X-Forwarded-For 绕过锁定）', () => {
  it('固定 client_id 每次换伪造 IP → 永不锁定（应达阈值后 429）', async () => {
    if (!connected) return it.skip('no DB');
    const { userId, appId, clientId } = await setup();
    try {
      const honoApp = makeApp() as { request: (url: string, init?: unknown) => Promise<Response> };
      const body = `grant_type=client_credentials&client_id=${clientId}&client_secret=wrong-secret`;

      // 每次发不同伪造 IP（30 次，远超阈值 10）
      let locked = false;
      let all401 = true;
      for (let i = 0; i < 30; i++) {
        const fakeIp = `10.0.${i >> 8}.${i & 0xff}`;
        const res = await honoApp.request('/oauth/token', {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': fakeIp,
          },
          body,
        });
        if (res.status === 429) {
          locked = true;
          break;
        }
        if (res.status !== 401) all401 = false;
      }
      // 修复后：计数 key 只按 clientId（不含可伪造 IP）→ 第 11 次起锁定（429）
      expect(locked).toBe(true);
      expect(all401).toBe(true);
      // 期望（修复后）：达阈值后锁定（429）。
      // 实际（BUG）：因 attemptKey 含伪造 IP，每次不同，永不锁定 → 全 401。
      expect(locked).toBe(true); // 当前 FAIL：locked=false（永不锁）
      expect(all401).toBe(true);
    } finally {
      await cleanup(userId, appId, clientId);
    }
  });
});
