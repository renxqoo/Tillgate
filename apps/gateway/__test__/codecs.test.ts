/**
 * 入站 codec 契约：
 * completions/responses/claude 三 codec 的 decode→encode 响应往返 + 流式转换存在性
 * （翻译函数本体在 @tillgate/ai protocol 有专测——此处锁路由消费面接线）。
 */
import { describe, expect, it } from 'vitest';
import {
  responsesCodec,
  claudeMessagesCodec,
  inferenceEndpoints,
} from '../src/http/contracts/inference-endpoints';
import { defined } from './defined';

const encoderOf = (path: string) => {
  const ep = defined(
    inferenceEndpoints.find((e) => e.path === path),
    `endpoint ${path}`,
  );
  return defined(ep.codec, `codec of ${path}`);
};

describe('completions codec', () => {
  const codec = encoderOf('/v1/completions');
  it('prompt → messages 规范形；chat 响应 → completions 线格式；流转换恒为流', () => {
    const canonical = codec.decodeRequest({ model: 'm', prompt: 'hello' }, 'm');
    expect(canonical).toMatchObject({ model: 'm' });
    expect(canonical.messages).toBeDefined();
    const wire = codec.encodeResponse({
      id: 'x',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    }) as { choices: Array<{ text: string }> };
    expect(Array.isArray(wire.choices)).toBe(true);
    expect(defined(wire.choices[0], 'choices[0]').text).toBe('hi');
    const stream = codec.encodeStream(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {}\n\n'));
          c.close();
        },
      }),
      'm',
    );
    expect(stream).toBeInstanceOf(ReadableStream);
  });
});

describe('responses codec', () => {
  const codec = encoderOf('/v1/responses');
  it('input → messages；chat 响应 → responses 线格式', () => {
    const canonical = codec.decodeRequest({ model: 'm', input: 'q' }, 'm');
    expect(canonical.messages).toBeDefined();
    const wire = codec.encodeResponse({
      id: 'r',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }) as Record<string, unknown>;
    expect(wire).toHaveProperty('id');
    expect(wire).not.toHaveProperty('choices');
  });
});

describe('claude messages codec', () => {
  const codec = encoderOf('/v1/messages');
  it('messages → 规范形；chat 响应 → claude 线格式（content 数组）', () => {
    const canonical = codec.decodeRequest(
      { model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
      'm',
    );
    expect(canonical.messages).toBeDefined();
    const wire = codec.encodeResponse({
      id: 'c',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'yo' }, finish_reason: 'stop' }],
    }) as { content: Array<{ text: string }> };
    expect(defined(wire.content[0], 'content[0]').text).toBe('yo');
  });
});

const upstream = () =>
  new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {}\n\n'));
      c.close();
    },
  });

describe('端点表', () => {
  it('三 codec 的 encodeStream 全部执行（线格式转换流存在性）', () => {
    expect(responsesCodec.encodeStream(upstream(), 'm')).toBeInstanceOf(ReadableStream);
    expect(claudeMessagesCodec.encodeStream(upstream(), 'm')).toBeInstanceOf(ReadableStream);
  });

  it('9 端点形状冻结（path/kind/codec 归属）', () => {
    expect(inferenceEndpoints.map((e) => [e.path, e.kind, e.codec != null])).toEqual([
      ['/v1/chat/completions', 'chat', false],
      ['/v1/embeddings', 'embeddings', false],
      ['/v1/completions', 'chat', true],
      ['/v1/responses', 'chat', true],
      ['/v1/messages', 'chat', true],
      ['/v1/images/generations', 'images', false],
      ['/v1/audio/speech', 'audio_speech', false],
      ['/v1/rerank', 'rerank', false],
      ['/v1/moderations', 'moderations', false],
    ]);
  });
});

describe('responses schema 显式 400 面（无法兑现的语义不静默丢弃）', () => {
  const responsesEndpoint = defined(
    inferenceEndpoints.find((e) => e.path === '/v1/responses'),
    'responses endpoint',
  );
  const rejects = (body: Record<string, unknown>): boolean =>
    !responsesEndpoint.schema.safeParse({ model: 'm', input: 'hi', ...body }).success;

  it('previous_response_id（含 null）与 background:true → 400', () => {
    expect(rejects({ previous_response_id: 'resp_x' })).toBe(true);
    expect(rejects({ previous_response_id: null })).toBe(true);
    expect(rejects({ background: true })).toBe(true);
    // 合法形态不误伤：background 缺省/false、store 任意、具名 function tool_choice
    expect(rejects({ background: false })).toBe(false);
    expect(rejects({ store: true })).toBe(false);
  });
  it('非 function 工具与空名 function 工具 → 400', () => {
    expect(rejects({ tools: [{ type: 'web_search_preview' }] })).toBe(true);
    expect(rejects({ tools: [{ type: 'function', parameters: {} }] })).toBe(true);
    expect(rejects({ tools: [{ type: 'function', name: 'f' }] })).toBe(false);
  });
  it('tool_choice 未知形态与 text.format 未知类型 → 400', () => {
    expect(rejects({ tool_choice: { type: 'allowed_tools' } })).toBe(true);
    expect(rejects({ tool_choice: { type: 'function' } })).toBe(true);
    expect(rejects({ tool_choice: 'required' })).toBe(false);
    expect(rejects({ tool_choice: { type: 'function', name: 'f' } })).toBe(false);
    expect(rejects({ text: { format: { type: 'grammar' } } })).toBe(true);
    expect(rejects({ text: { format: { type: 'json_object' } } })).toBe(false);
    expect(rejects({ text: { format: { type: 'json_schema', name: 'o', schema: {} } } })).toBe(
      false,
    );
  });
});
