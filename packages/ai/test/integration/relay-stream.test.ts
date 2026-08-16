import { describe, expect, it } from 'vitest';
import { SseScanner } from '../../src/transport/sse-parser.js';
import { fetchUpstream } from '../../src/transport/http-client.js';
import {
  relayStream,
  type RelayStreamEvent,
  type RelayStreamOptions,
} from '../../src/transport/relay-stream.js';
import { sseFrame, startServer, wait } from './helpers.js';

/**
 * relay-stream 集成场景：
 *   http 上游：正常 SSE 透传 / 流中断连（错误帧转换）
 *   mock 流：心跳注入（仅事件边界）/ inactivity 断流 / 客户端 abort 传播 / 流内错误帧
 */

const enc = (s: string) => new TextEncoder().encode(s);

const FAST_OPTS: RelayStreamOptions = { heartbeatIdleMs: 50, inactivityTimeoutMs: 2000 };

/** 可控上游流：手动 enqueue/close/error，记录是否被 cancel（abort 传播断言） */
function controllableStream() {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    enqueue: (s: string) => ctrl?.enqueue(enc(s)),
    close: () => ctrl?.close(),
    error: (e: unknown) => ctrl?.error(e),
    get cancelled() {
      return cancelled;
    },
  };
}

/** 消费 relay 输出流，收集文本与事件序列（事件按序） */
async function runRelay(upstream: ReadableStream<Uint8Array>, options: RelayStreamOptions) {
  const handle = relayStream(upstream, options);
  const events: RelayStreamEvent[] = [];
  handle.onEvent((e) => events.push(e));
  const reader = handle.stream.getReader();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(new TextDecoder().decode(value));
  }
  return { text: chunks.join(''), events };
}

describe('relay-stream（http 上游）', () => {
  it('正常 SSE：逐帧透传 + usage 提取 + done（无错误帧）', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: '你' } }] })));
      setTimeout(() => {
        res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: '好' } }] })));
        res.write(sseFrame(JSON.stringify({ usage: { prompt_tokens: 5, completion_tokens: 2 } })));
        res.write(sseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
        res.write(sseFrame('[DONE]'));
        res.end();
      }, 20);
    });
    try {
      const res = await fetchUpstream(
        server.baseUrl + '/v1/chat/completions',
        { method: 'POST' },
        {
          connectMs: 2000,
          allowLocal: true,
        },
      );
      expect(res.status).toBe(200);
      const { text, events } = await runRelay(res.body!, {
        heartbeatIdleMs: 10_000,
        inactivityTimeoutMs: 10_000,
      });
      // 透传完整性：三帧原样出现（含 usage 帧）
      expect(text).toContain('你');
      expect(text).toContain('好');
      expect(text).toContain('prompt_tokens');
      expect(text).toContain('[DONE]');
      // 事件序列：无 stream_error / aborted，done 最后携带 usage
      expect(events.filter((e) => e.type === 'stream_error')).toHaveLength(0);
      expect(events.filter((e) => e.type === 'aborted')).toHaveLength(0);
      expect(events.at(-1)?.type).toBe('done');
      const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
      expect(done.errorFrame).toBeNull();
      expect((done.usage as { prompt_tokens: number }).prompt_tokens).toBe(5);
    } finally {
      await server.close();
    }
  });

  it('断流：上游连接中断 → 注入 upstream_disconnected 错误帧 + aborted + done', async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
      setTimeout(() => res.destroy(), 30); // 模拟 TCP 半段断开
    });
    try {
      const res = await fetchUpstream(
        server.baseUrl + '/v1/chat/completions',
        { method: 'POST' },
        {
          connectMs: 2000,
          allowLocal: true,
        },
      );
      const { text, events } = await runRelay(res.body!, FAST_OPTS);
      // 错误帧转换：客户端能看到合成错误帧（OpenAI 兼容）
      expect(text).toContain('upstream_disconnected');
      expect(text).toContain('[DONE]');
      const reasons = events
        .filter((e) => e.type === 'aborted')
        .map((e) => (e as Extract<RelayStreamEvent, { type: 'aborted' }>).reason);
      expect(reasons).toContain('upstream_disconnected');
      const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
      expect(done.type).toBe('done');
      expect(done.errorFrame?.code).toBe('upstream_disconnected');
    } finally {
      await server.close();
    }
  });
});

describe('relay-stream（mock 流）', () => {
  it('心跳注入：静默超阈值注入 ": keep-alive"，仅事件边界且不拆事件', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, FAST_OPTS);
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
    await wait(160); // 静默 > 心跳阈值，应注入心跳
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'b' } }] })));
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
    mock.close();
    const { text, events } = await pending;
    expect(text).toContain(': keep-alive');
    // 心跳帧不拆事件：输出仍解析出 2 个完整事件
    const out = new SseScanner();
    out.consume(enc(text));
    expect(out.atBoundary()).toBe(true);
    const frames = text.match(/data: \{/g);
    expect(frames).toHaveLength(3);
    expect(text).toContain('[DONE]');
    // 正常结束：done 无错误
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.type).toBe('done');
    expect(done.errorFrame).toBeNull();
  });

  it('收到 finish_reason 但缺 DONE 时只补终止哨兵并保持成功', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, FAST_OPTS);
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
    mock.close();
    const { text, events } = await pending;
    expect(text.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(events.some((event) => event.type === 'aborted')).toBe(false);
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.terminated).toBeUndefined();
  });

  it('内容帧后 clean EOF 是截断：发结构化错误并以 DONE 收口', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, FAST_OPTS);
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })));
    mock.close();
    const { text, events } = await pending;
    expect(text).toContain('upstream_stream_truncated');
    expect(text).toContain('[DONE]');
    const aborted = events.find((event) => event.type === 'aborted') as Extract<
      RelayStreamEvent,
      { type: 'aborted' }
    >;
    expect(aborted.reason).toBe('upstream_truncated');
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.terminated).toBe('upstream_truncated');
  });

  it('心跳不拆半截事件：事件中途静默也不注入', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, FAST_OPTS);
    mock.enqueue('data: {"choices":[{"delta":{"content":"a"}}'); // 半截事件
    await wait(160);
    mock.enqueue('"}]}\n\n'); // 补完
    mock.close();
    const { text } = await pending;
    expect(text).not.toContain(': keep-alive');
    const out = new SseScanner();
    out.consume(enc(text));
    expect(out.atBoundary()).toBe(true);
  });

  it('inactivity：上游静默超时 → 注入 stream_inactivity_timeout 错误帧 + 断上游', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, { heartbeatIdleMs: 50, inactivityTimeoutMs: 80 });
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
    const { text, events } = await pending; // inactivity 触发后流会结束
    expect(text).toContain('stream_inactivity_timeout');
    const aborted = events.find((e) => e.type === 'aborted') as Extract<
      RelayStreamEvent,
      { type: 'aborted' }
    >;
    expect(aborted.reason).toBe('inactivity');
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.errorFrame?.code).toBe('stream_inactivity_timeout');
    expect(mock.cancelled).toBe(true); // 断上游：停止生成、停止计费
  });

  it('客户端 abort：输出流被取消 → 断上游 reader + aborted(client_disconnect)', async () => {
    const mock = controllableStream();
    const handle = relayStream(mock.stream, FAST_OPTS);
    const events: RelayStreamEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
    await reader.read();
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'b' } }] })));
    await reader.read();
    await reader.cancel('client gone'); // 客户端断开
    const aborted = events.find((e) => e.type === 'aborted') as Extract<
      RelayStreamEvent,
      { type: 'aborted' }
    >;
    expect(aborted.reason).toBe('client_disconnect');
    expect(events.at(-1)?.type).toBe('done'); // 部分 usage 仍可结算
    expect(mock.cancelled).toBe(true);
  });

  it('first_chunk：首个数据 chunk 通过时发一次性事件（TTFB 观察点），在终态事件之前', async () => {
    // 生产事故（req c2dee8ff）：网关在 chatStream 返回后才注册 onEvent，create-ai
    // 只重放终态事件 → 网关首个事件回调=流结束，TTFB 记成了"到终态的时长"。
    // 契约：首 chunk 流经 transform 时发 first_chunk（一次），网关据此记真实 TTFB。
    const mock = controllableStream();
    const handle = relayStream(mock.stream, FAST_OPTS);
    const events: RelayStreamEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'a' } }] })));
    await reader.read();
    mock.enqueue(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'b' } }] })));
    await reader.read();
    mock.enqueue(sseFrame('[DONE]'));
    mock.close();
    while (!(await reader.read()).done) {} // 排干至 EOF，flush 触发 done
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('first_chunk');
    expect(types.filter((t) => t === 'first_chunk')).toHaveLength(1); // 只发一次
    expect(types.at(-1)).toBe('done'); // 终态最后（既有契约不变）
    expect(types.indexOf('first_chunk')).toBeLessThan(types.indexOf('done'));
  });

  it('客户端 abort + 逐帧累计 usage：done 携带最新累计值（usage 是随行状态，非尾帧附属）', async () => {
    // 契约：供应商逐帧带累计 usage（如 OpenAI continuous_usage_stats）时，
    // 客户端取消的瞬间 scanner 已持最新值 → done.usage 即结算依据，不需要等到尾帧。
    const mock = controllableStream();
    const handle = relayStream(mock.stream, FAST_OPTS);
    const events: RelayStreamEvent[] = [];
    handle.onEvent((e) => events.push(e));
    const reader = handle.stream.getReader();
    mock.enqueue(
      sseFrame(
        JSON.stringify({
          choices: [{ delta: { content: 'a' } }],
          usage: { prompt_tokens: 10, completion_tokens: 3 },
        }),
      ),
    );
    await reader.read();
    mock.enqueue(
      sseFrame(
        JSON.stringify({
          choices: [{ delta: { content: 'b' } }],
          usage: { prompt_tokens: 10, completion_tokens: 7 },
        }),
      ),
    );
    await reader.read();
    mock.enqueue(sseFrame(JSON.stringify({ usage: null }))); // null 帧不得覆盖真值
    await reader.read();
    await reader.cancel('client gone');
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.terminated).toBe('client_disconnect');
    expect(done.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 7 }); // 最新累计
    expect(mock.cancelled).toBe(true);
  });

  it('上游错误帧：原样透传 + stream_error 事件 + done 携带错误帧', async () => {
    const mock = controllableStream();
    const pending = runRelay(mock.stream, FAST_OPTS);
    mock.enqueue(
      sseFrame(JSON.stringify({ error: { code: 'rate_limited', message: 'slow down' } })),
    );
    mock.enqueue(sseFrame(JSON.stringify({ usage: { prompt_tokens: 3 } })));
    mock.enqueue(sseFrame('[DONE]'));
    mock.close();
    const { text, events } = await pending;
    expect(text).toContain('slow down'); // 透传
    const se = events.find((e) => e.type === 'stream_error') as Extract<
      RelayStreamEvent,
      { type: 'stream_error' }
    >;
    expect(se.frame.code).toBe('rate_limited');
    const done = events.at(-1) as Extract<RelayStreamEvent, { type: 'done' }>;
    expect(done.errorFrame?.code).toBe('rate_limited');
    expect(done.terminated).toBe('upstream_error');
    expect((done.usage as { prompt_tokens: number }).prompt_tokens).toBe(3);
  });
});
