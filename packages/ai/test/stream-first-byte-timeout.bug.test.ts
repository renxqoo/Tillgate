import { describe, expect, it } from 'vitest';
import { peekFirstChunk, PeekTimeoutError } from '../src/internal/stream.js';

/**
 * 审计 P1-5：流式「首字节前」无超时——上游发完 headers 后挂起时，
 * peek 的 read() 永久 pending，客户端干等至总 deadline（240s）。
 * connectMs 只覆盖到响应头；inactivity 又只在首 chunk 后武装。
 * peek 必须有自己的首字节预算（timeoutMs），超时释放连接并抛类型化错误。
 */
describe('peekFirstChunk — 首字节超时', () => {
  it('上游挂起不吐首字节 → timeoutMs 后抛 PeekTimeoutError 并释放连接', async () => {
    let sourceCancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        sourceCancelled = true;
      },
    });
    const started = Date.now();
    await expect(peekFirstChunk(body, { timeoutMs: 80 })).rejects.toBeInstanceOf(
      PeekTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((r) => setTimeout(r, 10));
    expect(sourceCancelled).toBe(true);
  });

  it('首字节及时到达 → 不受 timeoutMs 影响', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        setTimeout(() => c.enqueue(new TextEncoder().encode('data: {}\n\n')), 20);
      },
      cancel() {},
    });
    const peeked = await peekFirstChunk(body, { timeoutMs: 2_000 });
    expect(peeked.done).toBe(false);
    await peeked.rest!.cancel();
  });
});
