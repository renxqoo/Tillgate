import { describe, expect, it } from 'vitest';
import {
  geminiRequestToChat,
  chatRequestToGemini,
  geminiResponseToChat,
  geminiUpstreamToCanonicalStream,
  canonicalStreamToGeminiStream,
  geminiUsageToUsage,
} from '../../src/protocol/gemini-chat';

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

const GEMINI_REQUEST = {
  systemInstruction: { parts: [{ text: 'Be brief.' }] },
  contents: [
    { role: 'user', parts: [{ text: 'Hi' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'SF' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 18 } } }] },
  ],
  tools: [{ functionDeclarations: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] }],
  generationConfig: { maxOutputTokens: 512, temperature: 0.5, stopSequences: ['END'] },
};

const GEMINI_RESPONSE = {
  candidates: [
    {
      content: { role: 'model', parts: [{ text: '18°C' }] },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 8, totalTokenCount: 28 },
};

describe('gemini ⇄ chat codec', () => {
  it('① 入站请求 → 规范形：systemInstruction/functionCall/functionResponse', () => {
    const chat = geminiRequestToChat(GEMINI_REQUEST, 'gemini-2.5-pro') as Record<string, any>;
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(chat.messages[1]).toEqual({ role: 'user', content: 'Hi' });
    expect(chat.messages[2].role).toBe('assistant');
    expect(chat.messages[2].tool_calls[0].function.name).toBe('get_weather');
    expect(chat.messages[3].role).toBe('tool');
    expect(chat.max_tokens).toBe(512);
    expect(chat.temperature).toBe(0.5);
    expect(chat.stop).toEqual(['END']);
    expect(chat.tools[0].function.name).toBe('get_weather');
  });

  it('② 规范形 → gemini（上游方向）：system 提取、functionCall 还原', () => {
    const chat = geminiRequestToChat(GEMINI_REQUEST, 'gemini-2.5-pro');
    const back = chatRequestToGemini(chat) as Record<string, any>;
    expect(back.systemInstruction.parts[0].text).toBe('Be brief.');
    expect(back.contents[1].role).toBe('model');
    expect(back.contents[1].parts.some((p: any) => p.functionCall?.name === 'get_weather')).toBe(true);
    expect(back.contents[2].parts[0].functionResponse.name).toBe('get_weather');
    expect(back.generationConfig.maxOutputTokens).toBe(512);
    expect(back.tools[0].functionDeclarations[0].name).toBe('get_weather');
  });

  it('③ 非流式响应 → 规范形：thoughtsToken 计入输出、cached 归一、finishReason 映射', () => {
    const chat = geminiResponseToChat(GEMINI_RESPONSE, 'gemini-2.5-pro') as Record<string, any>;
    expect(chat.choices[0].message.content).toBe('18°C');
    expect(chat.choices[0].finish_reason).toBe('stop');
    expect(chat.usage.prompt_tokens).toBe(20);
    expect(chat.usage.completion_tokens).toBe(8); // 5 candidates + 3 thoughts
    expect(chat.usage.prompt_tokens_details.cached_tokens).toBe(8);
    expect(geminiUsageToUsage(GEMINI_RESPONSE.usageMetadata)).toEqual({ promptTokens: 20, completionTokens: 8, cachedTokens: 8 });
  });

  it('④ 上游 alt=sse → 规范形：文本增量 + finishReason 终止 + usage + [DONE]', async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'He' }] } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'y' }] } }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 } })}\n\n`));
        c.close();
      },
    });
    const out = await streamToString(geminiUpstreamToCanonicalStream(upstream, 'gemini-2.5-pro'));
    expect(out).toContain('"content":"He"');
    expect(out).toContain('"content":"y"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"prompt_tokens":9');
    expect(out.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  it('⑤ 规范形 chunk 流 → gemini 数据帧流（客户端方向）', async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: { content: 'Yo' }, finish_reason: null }] })}\n\n`));
        c.enqueue(enc.encode(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\n`));
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const out = await streamToString(canonicalStreamToGeminiStream(upstream, 'gemini-2.5-pro'));
    expect(out).toContain('"parts":[{"text":"Yo"}]');
    expect(out).toContain('"finishReason":"STOP"');
    expect(out).toContain('"promptTokenCount":4');
    // 无 [DONE]（gemini 线格式没有哨兵）
    expect(out).not.toContain('[DONE]');
  });
});
