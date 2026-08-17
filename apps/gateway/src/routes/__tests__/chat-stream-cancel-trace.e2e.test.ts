import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOKEN_ESTIMATE_CALIBRATION, type AiEvent, type ChatStreamResult } from '@ai-gateway/ai';
import { eq } from 'drizzle-orm';
import { billingRequests, usageLogs } from '@ai-gateway/db/schema';
import { createBillingProcessor } from '@ai-gateway/ledger';
import { initOtel, clearRecentTraces, getRecentTraces } from '@ai-gateway/core';
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
 * 用户侧取消的估算结算（责任域政策，2026-08 拍板）：
 *   客户端中途取消且无可信 usage → 不再挂 uncertain，按已透传字节估算结算；
 *   链路上必须有显式「估算」步骤节点（billing.estimate，标注非真实获取），
 *   receipt 带 estimatedFor/bytesRelayed，usage_logs 标 estimated。
 * 上游故障类取消（upstream_*）不走估算——见 G1 测试（依旧 uncertain）。
 */

loadEnvFileIntoProcess();
ensureTestSecrets();

const db = createTestDb();
const redis = createTestRedis();

let connected = false;
beforeAll(async () => {
  await redis.connect().catch(() => {});
  connected = await isBackendAvailable(db, redis);
  if (connected) initOtel({ serviceName: 'gateway-test', mode: 'memory' });
});
afterAll(async () => {
  await redis.quit().catch(() => {});
  await db.$client.end().catch(() => {});
});

async function waitForSpans(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('链路追踪 + 估算结算：客户端断流取消', () => {
  it('流终态落链路 → 估算步骤节点 → estimated receipt 正常结算（settled）', async () => {
    if (!connected) return it.skip('no DB');
    clearRecentTraces();
    const userId = await createTestUser(db, '1000', 'cxtrace');
    const { token, keyHash } = await createTestApiKey(db, userId, 'cxtrace');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          let closeStream: (() => void) | null = null;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(
                new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
              );
              closeStream = () => c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({ type: 'first_chunk', requestId: 'cxtrace-test' });
              // 真实时序：响应已返回给客户端后，流才被取消（relay-stream cancel() → done）
              setTimeout(() => {
                closeStream?.();
                cb({
                  type: 'success',
                  requestId: 'cxtrace-test',
                  channelKey: 'cxtrace-ch',
                  usage: undefined,
                  durationMs: 80,
                  bytesRelayed: 6273,
                  terminated: 'client_disconnect',
                });
              }, 80);
            },
          };
        }),
      });

      const app = buildTestApp(db, redis, ai);
      const res = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: ids.externalModel,
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
          max_tokens: 1000, // 高于估算值（6273×0.03=188），验证硬夹不误伤
        }),
      });
      expect(res.status).toBe(200);
      await res.text();

      await waitForSpans(() =>
        getRecentTraces(20).some(
          (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 5,
        ),
      );
      const trace = getRecentTraces(20).find(
        (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 5,
      );
      expect(trace).toBeDefined();
      const spans = trace!.spans;

      // ① 流终态语义（stream.relay）
      const relay = spans.find((s) => s.name === 'stream.relay')!;
      expect(relay.attributes['stream.terminated']).toBe('client_disconnect');
      expect(relay.attributes['stream.bytes_relayed']).toBe(6273);

      // ② 估算步骤节点：显式标注「估算，非真实获取」+ 估算参数
      const estimate = spans.find((s) => s.name === 'billing.estimate');
      expect(estimate).toBeDefined();
      expect(estimate!.attributes['usage.estimated']).toBe(true);
      expect(estimate!.attributes['estimate.reason']).toBe('client_disconnect');
      expect(estimate!.attributes['estimate.bytes_relayed']).toBe(6273);
      expect(typeof estimate!.attributes['estimate.output_tokens']).toBe('number');

      // ③ 收尾：settled（估算）+ estimated 标记
      const finalize = spans.find((s) => s.name === 'billing.finalize');
      expect(finalize).toBeDefined();
      expect(finalize!.attributes['billing.finalize']).toBe('succeeded');
      expect(finalize!.attributes['usage.estimated']).toBe(true);

      // ④ 计费落库：settled + estimated usage_logs + receipt 凭证
      // 结算泵（幂等）：不再依赖本地 dev worker 的 ambient 结算——用例自足
      await vi.waitFor(async () => {
        const bill = await db.query.billingRequests.findFirst({
          where: eq(billingRequests.userId, userId),
        });
        if (bill && bill.status === 'settlement_pending') {
          await createBillingProcessor({
            db,
            options: {
              ownerId: 'e2e-settle',
              batchSize: 5,
              claimLeaseMs: 60_000,
              retryBaseMs: 10,
              retryMaxMs: 100,
              maxAttempts: 3,
            },
          }).runOnce([bill.requestId]);
        }
        expect(bill?.status).toBe('settled');
      });
      const bill = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.userId, userId),
      });
      expect(bill?.receipt).toMatchObject({
        estimatedFor: 'client_disconnect',
        bytesRelayed: 6273,
      });
      const receipt = bill?.receipt as { usage?: { estimated?: boolean } };
      expect(receipt.usage && receipt.usage.estimated).toBe(true);
      const usage = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.userId, userId),
      });
      expect(usage).toBeDefined();
      expect(usage?.estimated).toBe(true);
      // 测试自建模型走默认 tokensPerByte（0.12）；断言按校准配置单一真相动态计算
      const expectedOut = Math.min(
        Math.round(6273 * DEFAULT_TOKEN_ESTIMATE_CALIBRATION.tokensPerByte),
        1000,
      );
      expect(usage?.outputTokens).toBe(expectedOut);
      expect(Number(usage?.amount)).toBeLessThanOrEqual(Number(bill?.reservedAmount));
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
