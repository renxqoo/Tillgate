import { describe, expect, it } from 'vitest';
import { GeminiAdapter } from '../../src/adapters/gemini.js';
import { parseEventstreamFrames, eventstreamToClaudeSse } from '../../src/adapters/aws-bedrock.js';

/** GeminiAdapter 寻址/终改/usage 提取/探测（流翻译由 native-protocol-adapters 覆盖） */
describe('GeminiAdapter', () => {
  const adapter = new GeminiAdapter();
  const channel = { baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'g-key', protocol: 'gemini' };

  it('寻址：stream 动作切换 + 模型名编码 + x-goog-api-key', () => {
    const nonStream = adapter.planRequest(channel, { endpoint: 'chat', model: 'gemini-2.5-pro', requestId: 'r1', stream: false });
    expect(nonStream.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    const stream = adapter.planRequest(channel, { endpoint: 'chat', model: 'gemini-2.5-pro', requestId: 'r1', stream: true });
    expect(stream.path).toBe('/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(stream.headers['x-goog-api-key']).toBe('g-key');
  });

  it('终改：规范形 → gemini 体；流式删除 stream 字段', () => {
    const base = { model: 'm', messages: [{ role: 'user', content: 'hi' }] } as Record<string, unknown>;
    const nonStream = adapter.finalizeRequestBody(base, { endpoint: 'chat', model: 'm', stream: false });
    expect(nonStream).toHaveProperty('contents');
    const stream = adapter.finalizeRequestBody({ ...base, stream: true }, { endpoint: 'chat', model: 'm', stream: true });
    expect(stream).not.toHaveProperty('stream');
  });

  it('extractUsage：规范形 usage（cached_tokens）与原生 usageMetadata 双方言', () => {
    const canonical = adapter.extractUsage({
      usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
    });
    expect(canonical).toMatchObject({ inputTokens: 10, cachedInputTokens: 5, outputTokens: 3 });
    const native = adapter.extractUsage({
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, cachedContentTokenCount: 3 },
    });
    expect(native).toMatchObject({ inputTokens: 7, cachedInputTokens: 3, outputTokens: 2 });
    expect(adapter.extractUsage({})).toBeNull();
  });

  it('probeRequests：GET 模型列表 + api-key 头', () => {
    expect(adapter.probeRequests(channel)).toEqual([
      { path: '/v1beta/models', headers: { 'x-goog-api-key': 'g-key' } },
    ]);
  });
});

describe('bedrock eventstream：非字符串头值类型宽度跳过 + 半包缓冲', () => {
  it('数值类型头（bool/int）不阻塞解析，字符串头可读', () => {
    // 手工构造一帧：headers 含字符串头 + bool 头
    const payload = Buffer.from(JSON.stringify({ ok: 1 }), 'utf8');
    const headers = Buffer.concat([
      Buffer.from([4]), Buffer.from('ev:t'), Buffer.from([7]), Buffer.from([0, 4]), Buffer.from('data'),
      Buffer.from([1]), Buffer.from('b'), Buffer.from([4]), Buffer.from([1]),
    ]);
    const prelude = Buffer.alloc(8);
    const total = 12 + headers.length + payload.length + 4;
    prelude.writeUInt32BE(total, 0);
    prelude.writeUInt32BE(headers.length, 4);
    const message = Buffer.concat([
      prelude, Buffer.alloc(4), headers, payload, Buffer.alloc(4),
    ]);
    const { frames, rest } = parseEventstreamFrames(message);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.headers['ev:t']).toBe('data');
    expect(rest.length).toBe(0);
  });

  it('半包（不足一帧）返回空且不抛', () => {
    expect(parseEventstreamFrames(Buffer.from([0, 0, 0, 99])).frames).toEqual([]);
  });

  it('eventstreamToClaudeSse：payload 事件转 SSE 帧序列', async () => {
    const payload = Buffer.from(JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }), 'utf8');
    const name = Buffer.from(':event-type');
    const value = Buffer.from('payload');
    const headers = Buffer.concat([
      Buffer.from([name.length]), name, Buffer.from([7]),
      Buffer.from([value.length >> 8, value.length & 0xff]), value,
    ]);
    const total = 12 + headers.length + payload.length + 4;
    const prelude = Buffer.alloc(8);
    prelude.writeUInt32BE(total, 0);
    prelude.writeUInt32BE(headers.length, 4);
    const message = Buffer.concat([prelude, Buffer.alloc(4), headers, payload, Buffer.alloc(4)]);
    const out = await new Response(eventstreamToClaudeSse(toStream(message))).text();
    expect(out).toContain('event: payload');
    expect(out).toContain('"text":"hi"');
  });
});

function toStream(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(buf));
      controller.close();
    },
  });
}
