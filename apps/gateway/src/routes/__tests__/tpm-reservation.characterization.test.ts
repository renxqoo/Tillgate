import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UpstreamError } from '@ai-gateway/ai';
import {
  loadEnvFileIntoProcess,
  ensureTestSecrets,
  createTestDb,
  createTestRedis,
  isBackendAvailable,
  createTestUser,
  createTestApiKey,
  setupTestModel,
  cleanupTestData,
  buildTestApp,
  makeMockAi,
} from '../../testing/helpers.js';

/**
 * TPM 预占所有权特征测试（重构护栏，2026-08 重构前留档）：
 *
 * 管线对 {tpm}:request:{requestId} 预占 hash 的所有权契约——
 *   1) TPM 拒绝：原子性（一项不写，无 hash 残留）
 *   2) 授权拒绝（402）：显式释放（hash 删除、reserved 归零）
 *   3) 全候选耗尽且上游确定未计费（upstreamCharge=none）：finally 释放
 *   4) 全候选耗尽且上游计费状态未知（upstreamCharge=unknown）：不释放（留给 TTL/结算）
 *   5) 成功：不释放（移交结算 backfillTpm 归还 actual/释放 reserved）
 *
 * 这些语义目前散布在 llm-pipeline 的布尔标志 + 5 处手工调用点；
 * 重构为 TpmReservation 句柄后，本文件是行为不变的验收网。
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

function chatBody(model: string): Record<string, unknown> {
  return { model, messages: [{ role: 'user', content: 'hello world' }] };
}

function upstreamError(code: string, status?: number): UpstreamError {
  return {
    code,
    message: `mock ${code}`,
    retryable: true,
    status,
    circuitTrip: false,
    deadCredential: false,
    name: 'UpstreamError',
  } as UpstreamError;
}

describe('TPM 预占所有权特征（重构护栏）', () => {
  it('TPM 拒绝：原子性——不残留 request hash 与 reserved 计数', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'tpma');
    const { token, keyHash } = await createTestApiKey(db, userId, 'tpma');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const minute = Math.floor(Date.now() / 60_000);
    const actualKey = `{tpm}:actual:${minute}:user:${userId}:model:${ids.mappingId}`;
    try {
      await redis.set(actualKey, '999999999'); // 超过 DEFAULT_USER_TPM
      const ai = makeMockAi({
        chat: vi.fn(() => {
          throw new Error('should not reach upstream');
        }),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(chatBody(ids.externalModel)),
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string; request_id: string } };
      expect(body.error.code).toBe('rate_limit_exceeded');
      const hash = await redis.exists(`{tpm}:request:${body.error.request_id}`);
      expect(hash).toBe(0);
      const reserved = await redis.get(
        `{tpm}:reserved:${minute}:user:${userId}:model:${ids.mappingId}`,
      );
      expect(reserved === null || reserved === '0').toBe(true);
    } finally {
      await redis
        .del(
          actualKey,
          `rl:{rpm}:user:${userId}`,
          `rl:{rpm}:global`,
          `rl:{rpm}:model:${ids.mappingId}`,
        )
        .catch(() => {});
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('授权拒绝（402 余额不足）：TPM 预占已释放', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '0', 'tpmb'); // 余额 0 + 无信用 → 402
    const { token, keyHash } = await createTestApiKey(db, userId, 'tpmb');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    const minute = Math.floor(Date.now() / 60_000);
    try {
      const ai = makeMockAi({
        chat: vi.fn(() => {
          throw new Error('should not reach upstream');
        }),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(chatBody(ids.externalModel)),
      });
      expect(res.status).toBe(402);
      const body = (await res.json()) as { error: { code: string; request_id: string } };
      expect(body.error.code).toBe('insufficient_balance');
      const hash = await redis.exists(`{tpm}:request:${body.error.request_id}`);
      expect(hash).toBe(0);
      const reserved = await redis.get(
        `{tpm}:reserved:${minute}:user:${userId}:model:${ids.mappingId}`,
      );
      expect(reserved === null || reserved === '0').toBe(true);
    } finally {
      await redis
        .del(`rl:{rpm}:user:${userId}`, `rl:{rpm}:global`, `rl:{rpm}:model:${ids.mappingId}`)
        .catch(() => {});
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('全候选耗尽且上游确定未计费（quota_exhausted）：TPM 预占已释放', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'tpmc');
    const { token, keyHash } = await createTestApiKey(db, userId, 'tpmc');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chat: vi.fn(async () => ({
          status: 'error' as const,
          error: upstreamError('quota_exhausted', 429),
          durationMs: 5,
        })),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(chatBody(ids.externalModel)),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; request_id: string } };
      const requestId = body.error.request_id;
      const hashKey = `{tpm}:request:${requestId}`;
      // 2026-08-17 政策：上游计费未知不再保留 TPM（uncertain 冻结路径删除）→ 统一释放
      const hash = await redis.exists(hashKey);
      expect(hash).toBe(0);
      await redis.del(hashKey).catch(() => {});
    } finally {
      await redis
        .del(`rl:{rpm}:user:${userId}`, `rl:{rpm}:global`, `rl:{rpm}:model:${ids.mappingId}`)
        .catch(() => {});
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });

  it('成功：TPM 预占移交结算（管线不释放，hash 保留）', async () => {
    if (!connected) return it.skip('no DB');
    const userId = await createTestUser(db, '1000', 'tpme');
    const { token, keyHash } = await createTestApiKey(db, userId, 'tpme');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    let capturedRequestId = '';
    try {
      const ai = makeMockAi({
        chat: vi.fn(async ({ ctx }) => {
          capturedRequestId = ctx.requestId;
          return {
            status: 'success' as const,
            usage: {
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              estimated: false,
              raw: {},
            },
            body: { model: ids.realModel, choices: [] },
            durationMs: 5,
          };
        }),
      });
      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(chatBody(ids.externalModel)),
      });
      expect(res.status).toBe(200);
      expect(capturedRequestId).not.toBe('');
      // 移交：管线不释放（backfillTpm 由 worker 结算时处置）
      const hashExists = await redis.exists(`{tpm}:request:${capturedRequestId}`);
      expect(hashExists).toBe(1);
      await redis.del(`{tpm}:request:${capturedRequestId}`).catch(() => {});
    } finally {
      await redis
        .del(`rl:{rpm}:user:${userId}`, `rl:{rpm}:global`, `rl:{rpm}:model:${ids.mappingId}`)
        .catch(() => {});
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
