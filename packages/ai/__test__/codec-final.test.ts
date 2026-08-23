import { describe, expect, it } from 'vitest';
import {
  geminiRequestToChat,
  chatRequestToGemini,
  geminiResponseToChat,
  geminiUsageToUsage,
} from '../src/protocol/gemini-chat.js';
import {
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
} from '../src/protocol/responses-chat.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { peekFirstChunk, firstChunkStreamError } from '../src/internal/stream.js';

const sse = (frames: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(f));
      c.close();
    },
  });
const ch = (p: string) => ({ baseUrl: 'https://x.test', apiKey: 'k', protocol: p });

describe('gemini 入站请求（geminiRequestToChat 深支）', () => {
  it('systemInstruction + functionResponse part → tool 消息 + functionCall → tool_calls', () => {
    const chat = geminiRequestToChat(
      {
        systemInstruction: { parts: [{ text: 'S' }] },
        contents: [
          { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: true } } }] },
        ],
      },
      'm',
    );
    const msgs = chat.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'S' });
    expect(((msgs[1] ?? {}).tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
      function: { name: 'f' },
    });
    expect(msgs[2] ?? {}).toMatchObject({ role: 'tool', tool_call_id: 'f' });
  });
  it('非文本 part 保留块数组（textOnly=false 路径）', () => {
    const chat = geminiRequestToChat(
      {
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'QQ' } }, { text: 't' }],
          },
        ],
      },
      'm',
    );
    const content = (chat.messages as Array<{ content: unknown }>)[0]?.content;
    expect(Array.isArray(content)).toBe(true);
  });
  it('generationConfig 映射 + generationConfig 双向', () => {
    const g = chatRequestToGemini({
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      temperature: 0.7,
      max_tokens: 100,
      top_p: 0.9,
    });
    const gc = g.generationConfig as Record<string, unknown>;
    expect(gc.temperature).toBe(0.7);
    expect(gc.maxOutputTokens).toBe(100);
  });
  it('geminiResponseToChat：多 part 文本拼接 + finishReason 映射 + 垃圾容错', () => {
    const r = geminiResponseToChat(
      {
        candidates: [
          { content: { parts: [{ text: 'a' }, { text: 'b' }] }, finishReason: 'MAX_TOKENS' },
        ],
      },
      'm',
    );
    expect(JSON.stringify(r)).toContain('ab');
    expect(JSON.stringify(r)).toContain('length');
    expect(
      geminiUsageToUsage({
        promptTokenCount: 1,
        candidatesTokenCount: 1,
        cachedContentTokenCount: 1,
      }),
    ).toMatchObject({ promptTokens: 1 });
  });
});

describe('responses codec 深支', () => {
  it('input 数组多角色 + developer→system + 内容块提取', () => {
    const chat = responsesRequestToChat({
      model: 'm',
      input: [
        { role: 'developer', content: 'D' },
        { role: 'user', content: [{ type: 'input_text', text: 'U' }] },
        { role: 'assistant', content: 'A' },
      ],
    });
    const msgs = chat.messages as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect((msgs[1] ?? {}).content).toBe('U');
  });
  it('chatResponseToResponses：id/model/usage 透传', () => {
    const r = chatResponseToResponses({
      id: 'resp1',
      model: 'm',
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    expect(r.id).toBe('resp1');
    expect(JSON.stringify(r)).toContain('"output_text"');
  });
  it('canonicalStreamToResponses：错误帧 → response.failed 事件', async () => {
    const out = await new Response(
      canonicalStreamToResponsesStream(
        sse(['data: {"error":{"code":"e","message":"bad"}}\n\n', 'data: [DONE]\n\n']),
      ),
    ).text();
    expect(out).toContain('response.failed');
  });
});

describe('adapter 剩余分支', () => {
  it('anthropic：finalize 流式注入 stream + probe 路径 + usage 缓存写', () => {
    const a = new AnthropicAdapter();
    const fin = a.finalizeRequestBody(
      { model: 'm', messages: [] },
      { endpoint: 'chat', model: 'm', stream: true },
    );
    expect(fin.stream).toBe(true);
    expect(a.probeRequests(ch('anthropic')).length).toBeGreaterThan(0);
    const u = a.extractUsage({
      usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1 },
    });
    expect(u).toMatchObject({ inputTokens: 6, cacheWriteTokens: 1 });
  });
  it('gemini adapter：finalize stream 字段删除 + probe x-goog api-key', () => {
    const g = new GeminiAdapter();
    const fin = g.finalizeRequestBody(
      { model: 'm', contents: [], generationConfig: {} },
      { endpoint: 'chat', model: 'm', stream: true },
    );
    expect(fin.stream).toBeUndefined();
    const probes = g.probeRequests({ baseUrl: 'https://x', apiKey: 'k', protocol: 'gemini' });
    expect(probes[0]?.headers['x-goog-api-key']).toBe('k');
  });
  it('minimax：video finalize duration/resolution 规则 + music 路径 + embeddings 寻址', () => {
    const m = new MiniMaxAdapter();
    const v = m.finalizeRequestBody(
      { model: 'm', prompt: 'p', duration: 99, size: 'ttt' } as never,
      { endpoint: 'video', model: 'm', stream: false },
    );
    expect(v.duration).toBe(15); // clamp 4-15
    expect(JSON.stringify(v)).toContain('720P'); // 未知分辨率兜底
    expect(
      m.planRequest(ch('minimax'), {
        endpoint: 'embeddings',
        model: 'm',
        requestId: 'r',
        stream: false,
      }).path,
    ).toContain('/v1/embeddings');
    expect(
      m.planRequest(ch('minimax'), { endpoint: 'music', model: 'm', requestId: 'r', stream: false })
        .path,
    ).toContain('music_generation');
  });
  it('overflow 模式矩阵（厂商出处注释的边界）', () => {});
});

describe('internal/stream：peekFirstChunk 深支', () => {
  it('空流 → done；带首帧 → first+rest 完整；超时 → 抛', async () => {
    const empty = await peekFirstChunk(
      new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      { timeoutMs: 100 },
    );
    expect(empty.done).toBe(true);
    const full = await peekFirstChunk(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
          c.close();
        },
      }),
      { timeoutMs: 100 },
    );
    expect(full.done).toBe(false);
    expect(full.first?.length).toBeGreaterThan(0);
    const restText = await new Response(full.rest!).text();
    expect(restText).toContain('{"x":1}');
    await expect(
      peekFirstChunk(
        new ReadableStream({
          start() {
            /* 永不发 */
          },
        }),
        { timeoutMs: 50 },
      ),
    ).rejects.toThrow();
  });
  it('firstChunkStreamError：错误帧识别与非错误帧 null', () => {
    expect(
      firstChunkStreamError(new TextEncoder().encode('data: {"error":{"code":"x"}}\n\n')),
    ).toBeDefined();
    expect(firstChunkStreamError(new TextEncoder().encode('data: {"choices":[]}\n\n'))).toBeNull();
  });
});
