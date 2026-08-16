import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiEvent, ChatStreamResult } from '@ai-gateway/ai';
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
 * 链路完整性：request.failed 路径（TTFB 期客户端取消等）也必须有 billing.finalize 收尾 span。
 *
 * 生产事故（req 8cbbad83，2026-08-16 04:30）：客户端在 TTFB 时刻断开 →
 * failed(aborted) 事件 → request.failed 信号 → billing uncertain，
 * 但该路径不创建 billing.finalize span——链路只有 4 个 span、没有收尾节点，
 * 复核页看到的是「没有终态的悬空 trace」。
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

describe('链路追踪：request.failed 路径的收尾 span', () => {
  it('上游 failed 事件（TTFB 期取消 aborted）→ 仅 input 估算结算（settled）', async () => {
    if (!connected) return it.skip('no DB');
    clearRecentTraces();
    const userId = await createTestUser(db, '1000', 'failtrace');
    const { token, keyHash } = await createTestApiKey(db, userId, 'failtrace');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              // 真实时序复现：注册时同步重放 failed（客户端在 TTFB 期断开）
              cb({
                type: 'failed',
                requestId: 'failtrace-test',
                channelKey: 'failtrace-ch',
                error: { code: 'aborted', message: 'retry deadline exceeded' } as never,
              });
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
          max_tokens: 100,
        }),
      });
      // P0-3 修正：首字节前失败返回真实状态码（aborted → 408）而非 200+SSE 错误帧；
      // 计费语义不变（TTFB 期取消 → 仅 input 估算结算，见下方 span 断言）
      expect(res.status).toBe(408);
      await res.text();

      await waitForSpans(() =>
        getRecentTraces(20).some(
          (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 6,
        ),
      );

      const trace = getRecentTraces(20).find(
        (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 6,
      );
      expect(trace).toBeDefined();
      const spans = trace!.spans;

      // 用户侧取消（aborted）→ 仅 input 估算结算：收尾为 succeeded + estimated
      const finalize = spans.find((s) => s.name === 'billing.finalize');
      expect(finalize).toBeDefined();
      expect(finalize!.attributes['billing.finalize']).toBe('succeeded');
      expect(finalize!.attributes['usage.estimated']).toBe(true);

      // TTFB 语义：一个数据块都没流动（failed 在首块前）→ 不得记 ttfb
      // （旧逻辑把首个事件当 TTFB，会错记成终态时刻）
      const relaySpan = spans.find((s) => s.name === 'stream.relay');
      expect(relaySpan).toBeDefined();
      expect(relaySpan!.attributes['stream.ttfb_ms']).toBeUndefined();

      // 用户侧取消（aborted）→ 仅 input 估算结算（政策：TTFB 期取消收 input 不收 output）
      const estimate = spans.find((s) => s.name === 'billing.estimate');
      expect(estimate).toBeDefined();
      expect(estimate!.attributes['estimate.reason']).toBe('aborted');
      expect(estimate!.attributes['estimate.bytes_relayed']).toBe(0);
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
