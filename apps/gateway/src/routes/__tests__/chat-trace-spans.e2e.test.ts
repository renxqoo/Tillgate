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
  cleanupTestData,
  buildTestApp,
  makeMockAi,
  setupTestModel,
} from '../../testing/helpers.js';

/**
 * 阶段1（链路完整性）：一次流式请求 = 一条 trace 讲完完整故事。
 *
 *   POST /v1/chat/completions          根 span（request.id/user.id/http 状态）
 *    ├─ billing.authorize               预授权：结果/金额/可用余额
 *    ├─ upstream <provider>            真实模型调用：渠道/尝试序/上游状态/TTFB
 *    └─ billing.finalize               收尾：usage 汇总/最终渠道（结算前的网关侧终态）
 *
 * 本测试锁死：① 上下文传播（upstream 是根的子 span，而非孤儿 trace）
 * ② 计费/上游/收尾三类 span 的关键属性齐全（金额一律 string）。
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

/** 轮询等待异步收尾 span（recordSuccess 在流结束后异步落账） */
async function waitForSpans(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('链路追踪：一次请求一条完整 trace（阶段1）', () => {
  it('流式成功请求 → 根/预授权/上游/收尾 span 同 trace 且属性齐全', async () => {
    if (!connected) return it.skip('no DB');
    clearRecentTraces();
    const userId = await createTestUser(db, '1000', 'trspan');
    const { token, keyHash } = await createTestApiKey(db, userId, 'trspan');
    const ids = await setupTestModel(db, process.env.ENCRYPTION_KEY!);
    try {
      const ai = makeMockAi({
        chatStream: vi.fn(async (): Promise<ChatStreamResult> => {
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
              c.close();
            },
          });
          return {
            stream,
            onEvent: (cb: (e: AiEvent) => void) => {
              cb({
                type: 'success',
                requestId: 'trspan-test',
                channelKey: 'trspan-ch',
                usage: {
                  inputTokens: 10,
                  cachedInputTokens: 0,
                  outputTokens: 5,
                  estimated: false,
                  raw: {},
                },
                durationMs: 5,
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
      expect(res.status).toBe(200);
      await res.text(); // 消费完整流，触发收尾/落账

      await waitForSpans(() =>
        getRecentTraces(20).some(
          (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 4,
        ),
      );

      const trace = getRecentTraces(20).find(
        (t) => t.rootName === 'POST /v1/chat/completions' && t.spanCount >= 4,
      );
      expect(trace).toBeDefined();
      const spans = trace!.spans;
      const root = spans.find((s) => s.name === 'POST /v1/chat/completions')!;

      // ① 上下文传播：所有子 span 挂在根下（同一 traceId，parent 指向根）
      const authorize = spans.find((s) => s.name === 'billing.authorize');
      const upstream = spans.find((s) => s.name.startsWith('upstream '));
      const finalize = spans.find((s) => s.name === 'billing.finalize');
      expect(authorize).toBeDefined();
      expect(upstream).toBeDefined();
      expect(finalize).toBeDefined();
      for (const s of [authorize!, upstream!, finalize!]) {
        expect(s.traceId).toBe(root.traceId);
        expect(s.parentSpanId).toBe(root.spanId);
      }

      // ② 预授权 span：结果/金额（string）/可用余额
      expect(authorize!.attributes['billing.result']).toBe('authorized');
      expect(typeof authorize!.attributes['billing.amount_reserved']).toBe('string');
      expect(authorize!.attributes['billing.amount_reserved']).not.toBe('');
      expect(typeof authorize!.attributes['billing.available_balance']).toBe('string');

      // ③ 上游 span：上游状态码 + TTFB + 渠道/尝试序
      expect(upstream!.attributes['http.status_code']).toBe(200);
      expect(typeof upstream!.attributes['upstream.ttfb_ms']).toBe('number');
      expect(upstream!.attributes['channel.attempt']).toBe(1);
      expect(typeof upstream!.attributes['channel.id']).toBe('number');

      // ④ 收尾 span：usage 汇总 + 最终渠道（与 promote 的 channel.key 同源）
      expect(finalize!.attributes['billing.finalize']).toBe('succeeded');
      expect(finalize!.attributes['usage.input_tokens']).toBe(10);
      expect(finalize!.attributes['usage.output_tokens']).toBe(5);
      expect(typeof finalize!.attributes['channel.final']).toBe('string');
    } finally {
      await cleanupTestData(db, redis, userId, keyHash, ids);
    }
  });
});
