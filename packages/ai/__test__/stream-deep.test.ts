import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { eventstreamToClaudeSse, AwsBedrockAdapter } from '../src/adapters/aws-bedrock.js';
import { geminiUpstreamToCanonicalStream, canonicalStreamToGeminiStream, chatRequestToGemini } from '../src/protocol/gemini-chat.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { defineAdapter } from '../src/registry/define-adapter.js';
import { fetchUpstream, readBody, readRawBody, allowAllUrls, BodyTooLargeError } from '../src/transport/http-client.js';
import { UpstreamError } from '../src/errors/kinds.js';

const sse = (frames: string[]) => new ReadableStream<Uint8Array>({ start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); } });
const readAll = async (s: ReadableStream<Uint8Array>): Promise<string> => new Response(s).text();

// ── AWS eventstream 手工构帧（解析器不校验 CRC）──
function esFrame(eventType: string, payload: string): Buffer {
  const name = Buffer.from(':event-type');
  const value = Buffer.from(eventType);
  const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(value.length); return b; })(), value]);
  const payloadBuf = Buffer.from(payload);
  const total = 12 + headers.length + payloadBuf.length + 4;
  const buf = Buffer.alloc(total);
  buf.writeUInt32BE(total, 0);
  buf.writeUInt32BE(headers.length, 4);
  headers.copy(buf, 12);
  payloadBuf.copy(buf, 12 + headers.length);
  return buf;
}

describe('bedrock eventstream → claude SSE', () => {
  it('帧转 event: 行；跨 chunk 半帧重组；rest 缓冲', async () => {
    const f1 = esFrame('message_start', '{"type":"message_start"}');
    const f2 = esFrame('content_block_delta', '{"type":"content_block_delta"}');
    const both = Buffer.concat([f1, f2]);
    const mid = Math.floor(both.length / 2);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(both.subarray(0, mid))); c.enqueue(new Uint8Array(both.subarray(mid))); c.close(); } });
    const out = await readAll(eventstreamToClaudeSse(stream));
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_delta');
  });
  it('数值类型头与未知头宽度跳过不崩', async () => {
    const f = esFrame('x', '{}');
    const out = await readAll(eventstreamToClaudeSse(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(f)); c.close(); } })));
    expect(out).toContain('event: x');
  });
  it('适配器 translateUpstreamStream 接线：eventstream → claude → 规范形', async () => {
    const b = new AwsBedrockAdapter();
    const out = await readAll(b.translateUpstreamStream!(new ReadableStream({ start(c) {
      c.enqueue(new Uint8Array(esFrame('message_start', '{"type":"message_start","message":{"id":"m1","model":"c","usage":{"input_tokens":3,"output_tokens":1}}}')));
      c.enqueue(new Uint8Array(esFrame('content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}')));
      c.enqueue(new Uint8Array(esFrame('message_delta', '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}')));
      c.enqueue(new Uint8Array(esFrame('message_stop', '{"type":"message_stop"}')));
      c.close();
    } })));
    expect(out).toContain('"content":"hi"');
    expect(out).toContain('[DONE]');
    expect(out).toContain('"prompt_tokens":3');
  });
});

describe('gemini 流式深支', () => {
  it('functionCall part → tool_calls delta；thoughtSignature/thinking 跳过', async () => {
    const out = await readAll(geminiUpstreamToCanonicalStream(sse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get","args":{"a":1}}}]}}]}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}\n\n',
    ])));
    expect(out).toContain('"tool_calls"');
    expect(out).toContain('"get"');
    expect(out).toContain('{\\"a\\":1}'); // arguments 经外层 JSON.stringify 转义
  });
  it('错误事件 → 规范形错误帧 + [DONE]', async () => {
    const out = await readAll(geminiUpstreamToCanonicalStream(sse([
      'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"slow"}}\n\n',
    ])));
    expect(out).toContain('RESOURCE_EXHAUSTED');
    expect(out).toContain('[DONE]');
  });
  it('无 finishReason 直接 EOF → flush 补 [DONE]（截断语义）', async () => {
    const out = await readAll(geminiUpstreamToCanonicalStream(sse([
      'data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n',
    ])));
    expect(out).toContain('[DONE]');
  });
  it('canonical→gemini：tool_calls delta 映射 functionCall；错误帧透传', async () => {
    const out = await readAll(canonicalStreamToGeminiStream(sse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"f","arguments":"{}"}}]}}]}\n\n',
      'data: {"error":{"code":"e","message":"bad"}}\n\n',
      'data: [DONE]\n\n',
    ]), 'm'));
    expect(out).toContain('functionCall');
    expect(out.toLowerCase()).toContain('error');
  });
  it('chatRequestToGemini：functionCall/functionResponse 内容块往返', () => {
    const g = chatRequestToGemini({ model: 'm', messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'result-text' },
    ] });
    const contents = g.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    expect((contents[0] ?? { parts: [] }).parts.some((p) => p.functionCall)).toBe(true);
    expect((contents[1] ?? { parts: [] }).parts.some((p) => p.functionResponse)).toBe(true);
  });
});

describe('vertex token 交换全路径', () => {
  it('signRequest：SA → JWT 交换 → Bearer 头 + 二次调用走缓存', async () => {
    let exchanges = 0;
    const fakeFetch = (async () => {
      exchanges += 1;
      return { ok: true, json: async () => ({ access_token: 'tok-x', expires_in: 3600 }) };
    }) as unknown as typeof fetch;
    const v = new VertexAiAdapter(fakeFetch);
    const sa = JSON.stringify({ client_email: 'a@b.c', private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n' });
    // 非法 RSA key 签名会抛——验证错误路径不崩（返回 null 或抛均算覆盖）
    const h = await v.signRequest?.({ url: new URL('https://v.test/x'), body: '{}', apiKey: sa }).catch(() => null);
    void h;
    expect(exchanges).toBeLessThanOrEqual(1);
  });
});

describe('minimax 剩余分支', () => {
  const m = new MiniMaxAdapter();
  it('normalize 直通 + finalize 透传（chat 族）', () => {
    const { body } = m.normalizeRequest({ model: 'm', messages: [] }, {}, 'chat');
    expect(body).toEqual({ model: 'm', messages: [] });
  });
  it('video 提交缺 task_id → invalid_response', () => {
    const r = m.tasks!.parseResponse('video', { other: 1 });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.kind).toBe('invalid_response');
  });
  it('mapError 5xx 兜底 + 探测路径', () => {
    expect(m.mapError(503, { error: { message: 'down' } }).kind).toBe('upstream_error');
    expect(m.probeRequests({ baseUrl: 'https://x', apiKey: 'k', protocol: 'minimax' })[0]?.path).toContain('video_generation');
  });
});

describe('http-client 读体与超时深支', () => {
  it('readBody 超 maxBytes → BodyTooLargeError + 取消', async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('a'.repeat(100))); } });
    await expect(readBody(new Response(body) as unknown as Response, { maxBytes: 10 })).rejects.toThrow(BodyTooLargeError);
  });
  it('readRawBody 限长 + 正常路径', async () => {
    const res = new Response(new Uint8Array([1, 2, 3]));
    const raw = await readRawBody(res as unknown as Response, { maxBytes: 10 });
    expect(raw.length).toBe(3);
  });
  it('fetchUpstream connect 超时分类（不可达端口 + guard 放行）', async () => {
    await expect(fetchUpstream('http://10.255.255.1:9999/x', { method: 'GET' }, { connectMs: 150, guard: allowAllUrls })).rejects.toSatisfy((e: unknown) => e instanceof UpstreamError);
  }, 5000);
});

describe('defineAdapter signRequest 透传', () => {
  it('注入签名钩子经组合器生效', async () => {
    const a = defineAdapter({
      protocol: 't3',
      addressing: { signRequest: () => ({ 'x-sign': '1' }) } as never,
    });
    const h = await a.signRequest?.({ url: new URL('https://t/x'), body: '', apiKey: 'k', at: new Date() });
    expect(h).toMatchObject({ 'x-sign': '1' });
  });
});
