import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { apps, billingRequests, userSubscriptions } from '@ai-gateway/db/schema';
import type { UpstreamError } from '@ai-gateway/ai';
import { createSettlementProcessor } from '@ai-gateway/ledger/settlement';
import { createWallet } from '@ai-gateway/wallet';
import { Decimal } from '@ai-gateway/wallet/metering';
import { signJwt } from '../../services/auth/jwt.js';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  activeSubscriptionId,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  walletForTests,
} from '../../testing/helpers.js';

/**
 * 管线失败路径（402/403/404/503）+ OAuth 签发成功路径（JWT 全链路）。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

function networkError(): UpstreamError {
  const err = new Error('connect ECONNREFUSED') as UpstreamError;
  err.code = 'network';
  err.retryable = true;
  err.circuitTrip = true;
  err.deadCredential = false;
  return err;
}

/** 创建用户 + 应用（OAuth 凭证），返回 clientId/secret 明文 + JWT 所需信息 */
async function setupApp(userId: number, scope?: { models?: string[]; rpm?: number; tpm?: number }) {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 10);
  const clientId = 'cli-' + suffix;
  const clientSecret = 'secret-' + suffix;
  const [a] = await db
    .insert(apps)
    .values({
      appId: 'app-' + suffix,
      userId,
      clientId,
      clientSecretHash: createHash('sha256').update(clientSecret).digest('hex'),
      name: 'oauth-test',
      scope,
      status: 0,
    })
    .returning();
  return { appId: a!.id, clientId, clientSecret };
}

describe('管线失败路径', () => {
  it('缺少专用报价策略的多模态输入在预扣和上游前拒绝', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'multimodal');
    const { token, keyHash } = await createTestApiKey(db, userId, 'multimodal');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const ai = makeMockAi({ chat: vi.fn() });
    try {
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [
            {
              role: 'user',
              content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }],
            },
          ],
        }),
      });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'billing_quote_unavailable',
      );
      expect(ai.chat).not.toHaveBeenCalled();
      expect(
        await db.query.billingRequests.findFirst({ where: eq(billingRequests.userId, userId) }),
      ).toBeUndefined();
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('配置严格上界策略后多模态可正常调用并持久化可信 usage', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'multimodal-ok');
    const { token, keyHash } = await createTestApiKey(
      db,
      userId,
      'multimodal-ok',
      await activeSubscriptionId(db, userId),
    );
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!, {
      billingPolicy: {
        version: 1,
        billingMode: 'unified_input_tokens',
        maxInputTokens: 10_000,
        modalities: { image: { maxItems: 2, maxInlineBytes: 1_000_000 } },
      },
    });
    const ai = makeMockAi({
      chat: vi.fn(async () => ({
        status: 'success' as const,
        usage: {
          inputTokens: 500,
          cachedInputTokens: 0,
          outputTokens: 20,
          estimated: false,
          raw: { prompt_tokens: 500, completion_tokens: 20 },
        },
        body: { id: 'vision-ok', choices: [] },
        durationMs: 10,
      })),
    });
    try {
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'describe' },
                { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(200);
      expect(ai.chat).toHaveBeenCalledTimes(1);
      const billingRequest = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      expect(billingRequest?.status).toBe('settlement_pending');
      expect(
        (billingRequest?.receipt as { billingPolicyFingerprint?: string } | null)
          ?.billingPolicyFingerprint,
      ).toMatch(/^[a-f0-9]{64}$/);

      await createSettlementProcessor({
          db,
          wallet: createWallet(db, { accounts: [], refTypes: ['topup', 'billing'], currencies: ['CNY'] }),
        options: {
          ownerId: `multimodal-test-${randomUUID()}`,
          batchSize: 1,
          claimLeaseMs: 60_000,
          retryBaseMs: 10,
          retryMaxMs: 100,
          maxAttempts: 3,
        },
      }).runOnce([billingRequest!.requestId]);
      // 本机可能同时运行真实 Worker 并先拿到 claim；无论由哪一个实例结算，最终只能 settled 一次。
      await vi.waitFor(
        async () => {
          expect(
            await db.query.billingRequests.findFirst({
              where: eq(billingRequests.requestId, billingRequest!.requestId),
            }),
          ).toMatchObject({ status: 'settled' });
        },
        { timeout: 10_000, interval: 50 }, // 全量并行时真实 Worker 的结算可能 >3s
      );
      await db.query.users.findFirst({
        where: (table, { eq: equals }) => equals(table.id, userId),
      });
      // 包月 Key：结算扣订阅额度（(500×1000+20×2000)/1M = 0.54 元），余额不动（S7：读 wallet）
      expect(new Decimal(await walletForTests(db).balance(userId)).eq('1000')).toBe(true);
      const settledSub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.userId, userId),
      });
      expect(new Decimal(settledSub!.usedAmount).eq('0.54')).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('无有效订阅 → 402 subscription_required（key 绑到过期订阅）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'nosub');
    const subId = await activeSubscriptionId(db, userId);
    // 模拟到期：endAt 置为过去（等价到期，authorize 惰性判定 endAt <= now）
    await db
      .update(userSubscriptions)
      .set({ endAt: new Date(Date.now() - 60_000) })
      .where(eq(userSubscriptions.id, subId!));
    const { token, keyHash } = await createTestApiKey(db, userId, 'nosub', subId);
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const app = buildTestApp(db, redis, makeMockAi());
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hello world' }],
          max_tokens: 100,
        }),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('subscription_required');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('JWT scope.models 白名单外模型 → 403 model_not_allowed', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'err403');
    const { appId } = await setupApp(userId, { models: ['allowed-model-only'] });
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const token = await signJwt(
        { userId, appId, scope: { models: ['allowed-model-only'] }, rateCardId: null },
        process.env.JWT_SECRET!,
      );
      const app = buildTestApp(db, redis, makeMockAi());
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('model_not_allowed');
      expect(body.error.type).toBe('permission_error');
    } finally {
      await db
        .delete(apps)
        .where(eq(apps.id, appId))
        .catch(() => {});
      await cleanupTestData(db, redis, userId, null, ids);
    }
  });

  it('不存在的模型 → 404 model_not_found', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'err404');
    const { token, keyHash } = await createTestApiKey(db, userId, 'err404');
    try {
      const app = buildTestApp(db, redis, makeMockAi());
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'no-such-model-' + Date.now(),
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('model_not_found');
      expect(body.error.type).toBe('not_found_error');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, null);
    }
  });

  it('网络错误导致全部渠道耗尽 → 503，上游异常释放不扣（2026-08-17 政策）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'err503');
    const { token, keyHash } = await createTestApiKey(db, userId, 'err503');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'error' as const,
          error: networkError(),
          durationMs: 5,
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 100,
        }),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; type: string } };
      expect(body.error.code).toBe('no_available_channel');
      expect(body.error.type).toBe('server_error');
      // 网络错误不能证明上游未计费：保留 reservation 并进入人工复核。
      await new Promise((r) => setTimeout(r, 100));
      const requests = await db.query.billingRequests.findMany({
        where: eq(billingRequests.userId, userId),
        columns: { status: true },
      });
      expect(requests.every((request) => request.status === 'released')).toBe(true);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('OAuth client_credentials 签发成功 → JWT 可调 chat（全链路）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'oauthok');
    const { appId, clientId, clientSecret } = await setupApp(userId);
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'success' as const,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            estimated: false,
            raw: {},
          },
          body: { id: 'mock', object: 'chat.completion', choices: [] },
          durationMs: 5,
        })),
      });
      const app = buildTestApp(db, redis, ai);

      // 1. OAuth 签发
      const tokenRes = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        access_token: string;
        token_type: string;
        expires_in: number;
      };
      expect(tokenBody.token_type).toBe('Bearer');
      expect(tokenBody.expires_in).toBe(7200);
      expect(tokenBody.access_token).toBeTruthy();

      // 2. JWT 调 chat
      const chatRes = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${tokenBody.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      expect(chatRes.status).toBe(200);
      expect(ai.chat).toHaveBeenCalled();
    } finally {
      await redis.del(`oauth_attempts:${clientId}`).catch(() => {});
      await db
        .delete(apps)
        .where(eq(apps.id, appId))
        .catch(() => {});
      await cleanupTestData(db, redis, userId, null, ids);
    }
  });
});
