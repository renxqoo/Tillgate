import { describe, expect, it } from 'vitest';
import { peekFirstChunk } from '../../src/internal/stream.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

function makeStream(chunks: Uint8Array[], opts: { error?: unknown } = {}): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      if (opts.error) c.error(opts.error);
      else c.close();
    },
  });
}

describe('peekFirstChunk', () => {
  it('空流（立即 EOF）→ done=true', async () => {
    const body = makeStream([]);
    const r = await peekFirstChunk(body);
    expect(r.done).toBe(true);
    expect(r.first).toBeUndefined();
    expect(r.rest).toBeUndefined();
  });

  it('有首帧 → done=false，rest 包含 first + 剩余', async () => {
    const body = makeStream([enc('data: a\n\n'), enc('data: b\n\n')]);
    const r = await peekFirstChunk(body);
    expect(r.done).toBe(false);
    expect(r.first).toBeDefined();
    expect(dec(r.first!)).toBe('data: a\n\n');
    // rest 应包含 first + 后续
    const reader = r.rest!.getReader();
    const out: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(dec(value));
    }
    expect(out.join('')).toBe('data: a\n\ndata: b\n\n');
  });

  it('空 chunk（length=0）按 done 处理', async () => {
    const body = makeStream([new Uint8Array(0)]);
    const r = await peekFirstChunk(body);
    expect(r.done).toBe(true);
  });

  it('首帧后正常结束：rest 可读完整', async () => {
    const body = makeStream([enc('hello')]);
    const r = await peekFirstChunk(body);
    expect(r.done).toBe(false);
    const reader = r.rest!.getReader();
    const { value } = await reader.read();
    expect(dec(value!)).toBe('hello');
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('abort signal 触发 → reader.cancel（不 hang）', async () => {
    // 永不产数据的流（pending），靠 signal 中断
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue/close */
      },
    });
    const controller = new AbortController();
    const pending = peekFirstChunk(body, { signal: controller.signal }).catch((e) => e);
    controller.abort();
    const result = await pending;
    // cancel 后 read 以 done 返回（不抛）
    expect(result.done).toBe(true);
  });
});
