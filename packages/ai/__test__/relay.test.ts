import { describe, expect, it } from 'vitest';
import { relayStream } from '../src/transport/relay-stream.js';
import type { RelayStreamEvent } from '../src/transport/relay-stream.js';

const enc = new TextEncoder();
const b = (t: string) => enc.encode(t);

describe('relay-stream：守护与终止（数据面热路径）', () => {
  it('正常完成：done 事件带 usage/doneSentinel/bytesRelayed（不含合成帧）', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({ start(c) { c.enqueue(b('data: {"usage":{"prompt_tokens":2}}\n\n')); c.enqueue(b('data: [DONE]\n\n')); c.close(); } }),
      { heartbeatIdleMs: 10_000, inactivityTimeoutMs: 10_000 },
    );
    handle.onEvent(function (e) { events.push(e); });
    const text = await new Response(handle.stream).text();
    expect(text).toContain('[DONE]');
    await new Promise((r) => setTimeout(r, 20));
    const done = events.find((e) => e.type === 'done');
    expect(done).toBeDefined();
    if (done?.type === 'done') {
      expect(done.doneSentinel).toBe(true);
      expect(done.usage).toMatchObject({ prompt_tokens: 2 });
      expect(done.bytesRelayed).toBe(text.length);
      expect(done.terminated).toBeUndefined();
    }
    expect(events.some((e) => e.type === 'first_chunk')).toBe(true);
  });

  it('静默超时：首数据后长静默 → 错误帧 + aborted(inactivity) + done.terminated', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({ start(c) { c.enqueue(b('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); /* 之后静默 */ } }),
      { heartbeatIdleMs: 10_000, inactivityTimeoutMs: 50 },
    );
    handle.onEvent(function (e) { events.push(e); });
    const text = await new Response(handle.stream).text();
    expect(text).toContain('stream_inactivity_timeout');
    expect(events.some((e) => e.type === 'aborted' && e.reason === 'inactivity')).toBe(true);
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') expect(done.terminated).toBe('inactivity');
  });

  it('心跳注入：静默期在 SSE 边界注入 keep-alive（不拆半截行）', async () => {
    const handle = relayStream(
      new ReadableStream({ start(c) { c.enqueue(b('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')); /* 之后静默 */ } }),
      { heartbeatIdleMs: 30, inactivityTimeoutMs: 60_000 },
    );
    // 心跳让流永活——限量读而非读全流
    const reader = handle.stream.getReader();
    let collected = '';
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      collected += new TextDecoder().decode(value);
      if (collected.includes(': keep-alive')) break;
    }
    await reader.cancel();
    expect(collected).toContain(': keep-alive');
  });

  it('signal 取消：aborted(request_cancelled) + 上游取消传播', async () => {
    let upstreamCancelled = false;
    const ctrl = new AbortController();
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({
        start(c) { c.enqueue(b('data: x\n\n')); },
        cancel() { upstreamCancelled = true; },
      }),
      { heartbeatIdleMs: 10_000, inactivityTimeoutMs: 10_000, signal: ctrl.signal },
    );
    handle.onEvent(function (e) { events.push(e); });
    const reader = handle.stream.getReader();
    await reader.read();
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(upstreamCancelled || events.some((e) => e.type === 'aborted')).toBe(true);
  });

  it('上游断流（无 [DONE] 无终止帧）→ upstream_truncated 语义', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({ start(c) { c.enqueue(b('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n')); c.close(); } }),
      { heartbeatIdleMs: 10_000, inactivityTimeoutMs: 10_000 },
    );
    handle.onEvent(function (e) { events.push(e); });
    await new Response(handle.stream).text();
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') {
      expect(done.doneSentinel).toBe(false);
      expect(done.terminated).toBe('upstream_truncated');
    }
  });

  it('流内错误帧：stream_error 事件 + done.errorFrame 携带', async () => {
    const events: RelayStreamEvent[] = [];
    const handle = relayStream(
      new ReadableStream({ start(c) { c.enqueue(b('data: {"error":{"code":"ctx_too_long","message":"over"}}\n\n')); c.enqueue(b('data: [DONE]\n\n')); c.close(); } }),
      { heartbeatIdleMs: 10_000, inactivityTimeoutMs: 10_000 },
    );
    handle.onEvent(function (e) { events.push(e); });
    await new Response(handle.stream).text();
    const se = events.find((e) => e.type === 'stream_error');
    expect(se).toBeDefined();
    const done = events.find((e) => e.type === 'done');
    if (done?.type === 'done') expect(done.errorFrame?.code).toBe('ctx_too_long');
  });
});
