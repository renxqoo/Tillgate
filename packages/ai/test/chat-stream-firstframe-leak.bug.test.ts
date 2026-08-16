import { afterAll, describe, expect, it } from 'vitest';
import { createAi } from '../src/create-ai.js';
import { memoryDeps } from './helpers/memory-deps.js';

/**
 * 首帧错误路径连接泄漏回归（审计 P0-4 调用方侧）：200 + 流内首帧即错误时，
 * create-ai 放弃 peeked.rest 进入重试/失败——放弃的 rest（tee branchB，
 * 完整上游 body）必须被 cancel，否则 undici 连接永久挂起。
 *
 * 观测点：stub fetch 的 Response body 源 cancel 回调（tee 两分支均 cancel 后触发）。
 */
describe('createAi.chatStream — 首帧错误放弃 rest 释放连接', () => {
  const originalFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('首帧错误后底层 body 源被 cancel', async () => {
    let sourceCancelled = false;
    let fetchCalled = 0;
    const frame = 'data: {"error":{"code":"insufficient_quota","message":"insufficient quota"}}\n\n';
    globalThis.fetch = (async () => {
      fetchCalled += 1;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame));
          // 不 close：模拟连接仍保持（未消费即泄漏的场景）
        },
        cancel() {
          sourceCancelled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const ai = createAi({ allowLocalUrl: true }, memoryDeps());
    const result = await ai.chatStream({
      channel: { baseUrl: 'http://localhost:9/v1', apiKey: 'sk-test', protocol: 'openai-compatible' },
      request: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
      ctx: { requestId: 'leak-test-1', model: 'm', providerName: 'p', maxRetries: 0, deadlineMs: 5_000 },
    });

    // 首帧错误 → failEarly（终态事件在 onEvent 注册时重放）
    const events: { type: string }[] = [];
    result.onEvent((e) => events.push(e));
    expect(events.some((e) => e.type === 'failed')).toBe(true);
    expect(fetchCalled).toBe(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(sourceCancelled).toBe(true);
  });
});
