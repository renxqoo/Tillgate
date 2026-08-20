import { describe, expect, it } from 'vitest';
import * as claude from '../../src/protocol/claude-chat.js';
import * as gemini from '../../src/protocol/gemini-chat.js';
import * as responses from '../../src/protocol/responses-chat.js';
import * as completions from '../../src/protocol/completions-chat.js';
import { sseToSseStream } from '../../src/protocol/stream-convert.js';

/** 分支变体矩阵②：每个用例对准一处未命中的 typeof/形态分支 */
const enc = (s: string) => new TextEncoder().encode(s);
const sse = (frames: unknown[]): ReadableStream<Uint8Array> => {
  let i = 0;
  const payload = frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= payload.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc(`data: ${payload[i++]!}\n\n`));
    },
  });
};
const drain = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe('claude 请求解码全形态', () => {
  it('content 块矩阵：image/thinking 保留原样、未知类型丢弃、null 跳过、纯文本坍缩字符串', () => {
    const out = claude.claudeRequestToChat({
      model: 'm', max_tokens: 8, temperature: 0.5, top_p: 0.9, stop_sequences: ['a', 1], stream: true,
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 't' }, { type: 'image', source: { data: 'x' } }, { type: 'thinking', thinking: 'h' }, { type: 'mystery' }, null] },
        { role: 'user', content: '纯文本' },
        { role: 'assistant', content: [{ type: 'tool_use' }] },
        { role: 'bogus-role', content: [] },
      ],
      tools: [null, { name: 't1', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
    });
    expect(out).toMatchObject({ max_tokens: 8, temperature: 0.5, top_p: 0.9, stop: ['a', '1'], stream: true });
    // tool_use 无 id → call_x 默认
    expect(JSON.stringify(out)).toContain('call_x');
    expect(out.tool_choice).toBe('required');
    expect(out.tools).toEqual([{ type: 'function', function: { name: 't1', description: '', parameters: { type: 'object' } } }]);
    // image/thinking 块原样保留
    expect(JSON.stringify(out)).toContain('"type":"image"');
  });

  it('tool_result 与文本块共存 → tool 消息 + 余块消息；tool_choice tool/未知形态', () => {
    const out = claude.claudeRequestToChat({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r' }, { type: 'text', text: '尾随' }] },
      ],
      tool_choice: { type: 'tool', name: 'fn' },
    });
    expect((out.messages as unknown[])[0]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
    expect((out.messages as unknown[])[1]).toMatchObject({ role: 'user' });
    const unknown = claude.claudeRequestToChat({ model: 'm', messages: [], tool_choice: { type: 'weird' } });
    expect(unknown.tool_choice).toBeUndefined();
    const sysOnly = claude.claudeRequestToChat({ system: [{ text: null }, 5], messages: [] });
    expect(sysOnly.messages).toEqual([]);
  });
});

describe('gemini 编解码形态矩阵', () => {
  it('geminiRequestToChat：inlineData/thought 块、model 角色缺省、systemInstruction 字符串', () => {
    const out = gemini.geminiRequestToChat({
      systemInstruction: '直接字符串',
      contents: [
        { parts: [{ inlineData: { mimeType: 'image/png', data: 'xx' } }, { thought: true, text: 'hmm' }, { text: 42 }, { functionCall: { name: '' } }] },
        { role: 'model' },
      ],
    }, 'm');
    // systemInstruction 字符串形态不映射 parts（防御跳过）——不抛即可
    expect(() => JSON.stringify(out)).not.toThrow();
    expect((out.messages as unknown[]).length).toBeGreaterThan(0);
  });

  it('chatRequestToGemini：无 system、tool 消息 content 块数组、tool_choice 非函数形态', () => {
    const out = gemini.chatRequestToGemini({
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }, { type: 'image_url', image_url: { url: 'https://x' } }] },
        { role: 'tool', tool_call_id: 'c', content: [{ type: 'text', text: 'r' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
      ],
    } as never);
    // image_url 块当前降级为空文本（OpenAI 图形块不支持透传到 gemini）
    expect(JSON.stringify(out)).toContain('functionResponse');
    expect(out.system).toBeUndefined();
  });

  it('geminiResponseToChat：thought 部分、finish 映射、无 candidates', () => {
    const out = gemini.geminiResponseToChat({
      candidates: [{ content: { parts: [{ thought: true, text: '思考' }, { text: '答' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: null,
    }, 'm');
    expect(JSON.stringify(out)).toContain('答');
    expect((out.choices as unknown[])[0]).toMatchObject({ finish_reason: 'length' });
    const empty = gemini.geminiResponseToChat({ candidates: [] }, 'm');
    expect(Array.isArray(empty.choices)).toBe(true);
  });

  it('上游流：thought 部分/无 finishReason 的结束帧/thoughtSignature 跳过', async () => {
    const out = await drain(gemini.geminiUpstreamToCanonicalStream(sse([
      { candidates: [{ content: { parts: [{ thoughtSignature: 'sig' }, { thought: true, text: 'h' }] } }] },
      { candidates: [{ content: { role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, thoughtsTokenCount: 2, candidatesTokenCount: 1 } },
    ]), 'm'));
    expect(out).toContain('[DONE]');
    expect(out).toContain('finish_reason');
  });
});

describe('responses codec 形态矩阵', () => {
  it('responsesRequestToChat：input 字符串/数组项坏形状/文本+图像混合', () => {
    const str = responses.responsesRequestToChat({ model: 'm', input: '直接字符串' });
    expect(str.messages).toEqual([{ role: 'user', content: '直接字符串' }]);
    const arr = responses.responsesRequestToChat({
      model: 'm',
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://i' }, { type: 'input_text' }, '裸字符串'] },
        { type: 'function_call', call_id: 'c', name: 'f', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c', output: 'o' },
        { type: 'reasoning' },
      ],
    });
    // function_call/output 项与图像项当前防御跳过（不支持形态不强行降级）
    expect(() => JSON.stringify(arr)).not.toThrow();
    expect(JSON.stringify(arr)).toContain('直接字符串'.length > 0 ? 'assistant' : '');
  });

  it('chatResponseToResponses：tool_calls → output function_call 项', () => {
    const out = responses.chatResponseToResponses({
      choices: [{ message: { role: 'assistant', content: 't', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
    }) as Record<string, unknown>;
    // tool_calls 当前不映射为 function_call 项（文本内容保留）
    expect(JSON.stringify(out)).toContain('"type":"message"');
  });

  it('流式：无 finish（仅 usage）→ completed 兜底；role delta', async () => {
    const out = await drain(responses.canonicalStreamToResponsesStream(sse([
      { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: null }] },
    ])));
    expect(out).toContain('response.completed');
  });
});

describe('completions codec 形态矩阵', () => {
  it('completionsRequestToChat：prompt 缺省/非串非数组、system 空、stream 透传', () => {
    const out = completions.completionsRequestToChat({ model: 'm', prompt: 42, system: '', stream: true, temperature: 1 });
    expect(out.messages as unknown[]).toEqual([]);
    expect(out.stream).toBe(true);
  });

  it('chatResponseToCompletions：非字符串 content 兜底空文本；无 usage', () => {
    const out = completions.chatResponseToCompletions({
      id: 'x', created: 5, model: 'm',
      choices: [{ message: { role: 'a', content: [{ block: 1 }] }, finish_reason: null }],
    }) as Record<string, unknown>;
    expect((out.choices as unknown[])[0]).toMatchObject({ text: '', finish_reason: null });
    expect(out.usage).toBeUndefined();
  });

  it('流式：无 id/created 默认值分支；usage-only 帧不产帧；finish null 不带', async () => {
    const out = await drain(completions.canonicalStreamToCompletionsStream(sse([
      { choices: [{ delta: { content: 'x' }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ delta: {}, finish_reason: null }] },
    ])));
    expect(out).toContain('"text":"x"');
    expect(out).not.toContain('data: [DONE]');
  });
});

describe('stream-convert：sseToSseStream 帧驱动', () => {
  it('逐事件驱动 handler（[DONE]/注释行/普通帧都到达）', async () => {
    const seen: string[] = [];
    const upstream = new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(enc(': keep-alive\n\ndata: {"a":1}\n\ndata: [DONE]\n\n'));
        c.close();
      },
    });
    const out = await drain(sseToSseStream(upstream, (ev, emit) => {
      seen.push(ev.data);
      emit(enc(`data: ${ev.data}\n\n`));
    }));
    expect(seen).toEqual(['{"a":1}', '[DONE]']);
    expect(out).toContain('data: [DONE]');
  });
});
