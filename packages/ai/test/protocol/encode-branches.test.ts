import { describe, expect, it } from 'vitest';
import {
  canonicalStreamToClaudeStream,
  chatResponseToClaude,
} from '../../src/protocol/claude-chat.js';
import {
  canonicalStreamToGeminiStream,
  chatResponseToGemini,
} from '../../src/protocol/gemini-chat.js';
import {
  canonicalStreamToCompletionsStream,
  chatResponseToCompletions,
} from '../../src/protocol/completions-chat.js';

/** 流工具：SSE data 帧序列 → 流 */
function sse(frames: Array<string | Record<string, unknown>>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const lines = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(lines[i++]!));
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe('非流式编码方向：tool_calls / 参数损坏 / finish 映射分支', () => {
  it('chatResponseToClaude：tool_use 块（含参数 JSON 损坏兜底 {}）+ cache usage', () => {
    const out = chatResponseToClaude({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '先说两句',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
            { id: 'call_2', type: 'function', function: { name: 'bad', arguments: '{not-json' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 6 } },
    }) as Record<string, unknown>;
    const content = out.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: '先说两句' });
    expect(content[1]).toMatchObject({ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: '北京' } });
    expect(content[2]).toMatchObject({ type: 'tool_use', id: 'call_2', name: 'bad', input: {} });
    expect(out.stop_reason).toBe('tool_use');
    expect(out.usage).toMatchObject({ input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 6 });
  });

  it('chatResponseToClaude：finish content_filter → refusal', () => {
    const out = chatResponseToClaude({
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
    }) as Record<string, unknown>;
    expect(out.stop_reason).toBe('refusal');
  });

  it('chatResponseToGemini：functionCall parts（参数损坏兜底 {}）+ usage', () => {
    const out = chatResponseToGemini({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '查一下',
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'search', arguments: '{bad' } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 8, completion_tokens: 2 },
    }) as Record<string, unknown>;
    const parts = (out.candidates as unknown[])[0] as { content: { parts: Array<Record<string, unknown>> } };
    const partList = parts.content.parts;
    expect(partList[0]).toEqual({ text: '查一下' });
    expect(partList[1]).toEqual({ functionCall: { name: 'search', args: {} } });
    expect(out.usageMetadata).toMatchObject({ promptTokenCount: 8, candidatesTokenCount: 2 });
  });

  it('chatResponseToCompletions：message.content 提取 + finish 映射', () => {
    const out = chatResponseToCompletions({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) as Record<string, unknown>;
    expect((out.choices as unknown[])[0]).toMatchObject({ text: 'hello', finish_reason: 'length' });
    expect(out.usage).toMatchObject({ prompt_tokens: 3 });
  });
});

describe('流式编码方向分支', () => {
  it('canonicalStreamToClaudeStream：role 帧、tool_calls 增量、finish 映射与 usage 汇总', async () => {
    const out = await readAll(canonicalStreamToClaudeStream(sse([
      { id: 'cmpl-1', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"x"}' } }] }, finish_reason: null }] },
      { id: 'cmpl-1', choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
      '[DONE]',
    ]), 'claude-x'));
    expect(out).toContain('"type":"message_start"');
    expect(out).toContain('"type":"content_block_start"');
    expect(out).toContain('"type":"text_delta","text":"你好"');
    expect(out).toContain('"type":"tool_use"');
    expect(out).toContain('"type":"input_json_delta","partial_json":"{\\"city\\":\\"x\\"}"');
    expect(out).toContain('"stop_reason":"max_tokens"');
    expect(out).toContain('"input_tokens":7');
    // [DONE] 在 claude 协议面译为 message_stop 事件（不是裸 [DONE]）
    expect(out).toContain('"type":"message_stop"');
  });

  it('canonicalStreamToClaudeStream：解析失败帧与无内容帧被跳过', async () => {
    const out = await readAll(canonicalStreamToClaudeStream(sse([
      'not-json',
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: null }] },
      '[DONE]',
    ]), 'm'));
    expect(out).toContain('message_start');
    expect(out).not.toContain('text_delta');
  });

  it('canonicalStreamToGeminiStream：文本增量 + finish + usageMetadata 汇总帧', async () => {
    const out = await readAll(canonicalStreamToGeminiStream(sse([
      { id: 'c', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
      { id: 'c', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } },
      '[DONE]',
    ]), 'gemini-x'));
    expect(out).toContain('"text":"hi"');
    expect(out).toContain('"finishReason":"STOP"');
    expect(out).toContain('"promptTokenCount":5');
  });

  it('canonicalStreamToCompletionsStream：[DONE] 透传、坏帧跳过、text/finish 帧、usage-only 帧不产 text', async () => {
    const out = await readAll(canonicalStreamToCompletionsStream(sse([
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] },
      'not-json',
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 2, completion_tokens: 1 } },
      { id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ])));
    const frames = out.split('\n\n').filter((l) => l.startsWith('data: '));
    expect(frames.at(-1)).toBe('data: [DONE]');
    expect(out).toContain('"text":"a"');
    expect(out).toContain('"finish_reason":"stop"');
    expect(out).toContain('"object":"text_completion"');
  });
});
