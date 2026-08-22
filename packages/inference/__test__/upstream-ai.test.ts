import { describe, expect, it } from 'vitest';
import type { Ai, AiEvent, ChatResult } from '@tokenlens/ai';
import { createUpstreamAi } from '../src/adapters/upstream-ai';
import type { UpstreamStreamEvent } from '../src/ports/upstream';
import { channel, upstreamError } from './harness';

const noopEmit: (e: AiEvent) => void = () => {};

function fakeAi(handlers: {
  chat?: (desc: unknown, body: unknown, opts: unknown) => Promise<ChatResult> | ChatResult;
  chatStream?: (
    desc: unknown,
    body: unknown,
    opts: unknown,
  ) => {
    stream: ReadableStream<Uint8Array>;
    events: { subscribe: (cb: (e: AiEvent) => void) => void };
  };
  parse?: (desc: unknown, kind: 'video' | 'music', body: unknown) => unknown;
}) {
  const seen: { desc: unknown; body: unknown; opts: unknown }[] = [];
  const ai = {
    chat: async (desc: unknown, body: unknown, opts: unknown) => {
      seen.push({ desc, body, opts });
      return handlers.chat?.(desc, body, opts) ?? { ok: true, durationMs: 1 };
    },
    chatStream: async (desc: unknown, body: unknown, opts: unknown) => {
      seen.push({ desc, body, opts });
      return (
        handlers.chatStream?.(desc, body, opts) ?? {
          stream: new ReadableStream<Uint8Array>(),
          events: { subscribe: () => {} },
        }
      );
    },
    use: () => {
      throw new Error('unused');
    },
    probe: async () => ({ ok: true, durationMs: 1 }),
    subscribe: () => () => {},
    SUPPORTED_PROTOCOLS: ['openai-compatible'],
    tasks: {
      parse: (desc: unknown, kind: 'video' | 'music', body: unknown) =>
        handlers.parse?.(desc, kind, body) ?? { kind: 'task_submitted', taskId: 't-1' },
      query: async () => ({ ok: true, status: 'running' as const }),
      file: async () => ({ ok: true, downloadUrl: 'https://f' }),
    },
  } as unknown as Ai;
  return { ai, seen };
}

const req = {
  requestId: 'req-1',
  externalModel: 'gpt-x',
  realModel: 'gpt-x-real',
  endpoint: 'chat' as const,
  body: { model: 'gpt-x', messages: [] },
  deadlineMs: 120_000,
};

describe('adapters/upstream-ai：ChannelDesc 组装 + 凭据注入 + 结果/事件映射', () => {
  it('ChannelDesc：baseUrl/protocol 直传、凭据经 decrypt 注入、vendor 可选；模型名替换为 realModel', async () => {
    const { ai, seen } = fakeAi({});
    const port = createUpstreamAi({ ai, decrypt: (enc) => `plain:${enc}` });
    await port.chat(channel({ vendor: 'deepseek' }), req);
    expect(seen[0]?.desc).toEqual({
      baseUrl: 'https://up.example.com/v1',
      apiKey: 'plain:enc-7',
      protocol: 'openai-compatible',
      vendor: 'deepseek',
    });
    expect(seen[0]?.opts).toMatchObject({
      requestId: 'req-1',
      model: 'gpt-x-real',
      endpoint: 'chat',
      deadlineMs: 120_000,
    });
    // vendor=null 时不携带键（非 null 传值）
    await port.chat(channel(), req);
    expect(seen[1]?.desc).not.toHaveProperty('vendor');
  });

  it('chat 结果零包装直通（可信 usage 与错误原样）；signal 透传', async () => {
    const usage = {
      inputTokens: 5,
      cachedInputTokens: 0,
      outputTokens: 6,
      estimated: false,
      raw: null,
    };
    const { ai } = fakeAi({ chat: () => ({ ok: true, usage, durationMs: 9, body: { done: 1 } }) });
    const port = createUpstreamAi({ ai, decrypt: (s) => s });
    const ok = await port.chat(channel(), req);
    expect(ok).toEqual({ ok: true, usage, durationMs: 9, body: { done: 1 } });
    const error = upstreamError('rate_limited', { status: 429 });
    const { ai: ai2 } = fakeAi({ chat: () => ({ ok: false, error, durationMs: 3 }) });
    const port2 = createUpstreamAi({ ai: ai2, decrypt: (s) => s });
    expect(await port2.chat(channel(), req)).toEqual({ ok: false, error, durationMs: 3 });
    // 调用方取消信号透传（abort 语义在 ai 侧闭环）
    const controller = new AbortController();
    const { ai: ai3, seen } = fakeAi({});
    const port3 = createUpstreamAi({ ai: ai3, decrypt: (s) => s });
    await port3.chat(channel(), { ...req, signal: controller.signal });
    expect((seen[0]!.opts as { signal?: AbortSignal }).signal).toBe(controller.signal);
    await port3.chat(channel(), req);
    expect((seen[1]!.opts as { signal?: AbortSignal }).signal).toBeUndefined();
  });

  it('chatStream：事件面 → 端口三类映射（first_chunk/failed/success）；其余事件不进端口', async () => {
    let push: (e: AiEvent) => void = noopEmit;
    const { ai } = fakeAi({
      chatStream: () => ({
        stream: new ReadableStream<Uint8Array>(),
        events: {
          subscribe: (cb) => {
            push = cb;
          },
        },
      }),
    });
    const port = createUpstreamAi({ ai, decrypt: (s) => s });
    const result = await port.chatStream(channel(), req);
    const received: UpstreamStreamEvent[] = [];
    result.onEvent((e) => received.push(e));
    push({ type: 'attempt_start', requestId: 'r', channelKey: 'k', attempt: 1, atMs: 1 });
    push({ type: 'first_chunk', requestId: 'r', atMs: 123 });
    push({ type: 'stream_error', requestId: 'r', frame: { code: 'x' } });
    push({ type: 'aborted', requestId: 'r', reason: 'inactivity' });
    push({
      type: 'success',
      requestId: 'r',
      channelKey: 'k',
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 2, estimated: false, raw: null },
      durationMs: 55,
      terminated: 'client_disconnect',
      bytesRelayed: 99,
      outputFeatures: { cjkChars: 1, wordSegments: 0, numberSegments: 0, symbolCount: 0 },
    });
    const error = upstreamError('network');
    push({ type: 'failed', requestId: 'r2', channelKey: 'k', error });
    expect(received).toEqual([
      { type: 'first_chunk', atMs: 123 },
      {
        type: 'success',
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          estimated: false,
          raw: null,
        },
        terminated: 'client_disconnect',
        bytesRelayed: 99,
        outputFeatures: { cjkChars: 1, wordSegments: 0, numberSegments: 0, symbolCount: 0 },
        durationMs: 55,
      },
      { type: 'failed', error },
    ]);
  });

  it('submitTask：endpoint=kind 提交，parse task_submitted → upstreamTaskId', async () => {
    const { ai, seen } = fakeAi({});
    const port = createUpstreamAi({ ai, decrypt: (s) => s });
    const result = await port.submitTask(channel(), 'video', { ...req, endpoint: 'video' });
    expect(result).toEqual({ ok: true, upstreamTaskId: 't-1' });
    expect(seen[0]?.opts).toMatchObject({ endpoint: 'video', model: 'gpt-x-real' });
  });

  it('submitTask：同步完成（task_completed）→ null；parse error 与 chat 失败直通', async () => {
    const completed = fakeAi({ parse: () => ({ kind: 'task_completed', artifact: {} }) });
    const port1 = createUpstreamAi({ ai: completed.ai, decrypt: (s) => s });
    expect(await port1.submitTask(channel(), 'video', { ...req, endpoint: 'video' })).toEqual({
      ok: true,
      upstreamTaskId: null,
    });
    const parseError = upstreamError('invalid_response');
    const errored = fakeAi({ parse: () => ({ kind: 'error', error: parseError }) });
    const port2 = createUpstreamAi({ ai: errored.ai, decrypt: (s) => s });
    expect(await port2.submitTask(channel(), 'video', req)).toEqual({
      ok: false,
      error: parseError,
    });
    const chatError = upstreamError('network');
    const failed = fakeAi({ chat: () => ({ ok: false, error: chatError, durationMs: 0 }) });
    const port3 = createUpstreamAi({ ai: failed.ai, decrypt: (s) => s });
    expect(await port3.submitTask(channel(), 'video', req)).toEqual({
      ok: false,
      error: chatError,
    });
  });
});
