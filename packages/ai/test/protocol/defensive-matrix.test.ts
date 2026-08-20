import { describe, expect, it } from 'vitest';
import * as claude from '../../src/protocol/claude-chat.js';
import * as gemini from '../../src/protocol/gemini-chat.js';
import * as responses from '../../src/protocol/responses-chat.js';
import * as completions from '../../src/protocol/completions-chat.js';

/**
 * 防御矩阵：退化输入（缺字段/错类型/坏 JSON）灌进全部 codec 导出——
 * 防御分支是行为契约（坏形状不抛、缺省兜底），不是死代码。
 */
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

describe('claude codec 防御矩阵', () => {
  it('claudeRequestToChat：system 多形态（string/数组/缺省）、tool_result 坏形状、content 块坏形状', () => {
    // system 三形态
    const sysStr = claude.claudeRequestToChat({ messages: [], system: 's' }) as { messages: unknown[] };
    expect(sysStr.messages[0]).toMatchObject({ role: 'system' });
    const sysArr = claude.claudeRequestToChat({ messages: [], system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) as { messages: unknown[] };
    expect(sysArr.messages[0]).toMatchObject({ role: 'system', content: 'ab' });
    expect(claude.claudeRequestToChat({ messages: [] }).messages).toEqual([]);
    // tool_result：字符串 content / 块数组 content / 坏 tool_use_id
    const withToolResult = claude.claudeRequestToChat({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'plain' }] },
        { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'blk' }] }] },
        { role: 'user', content: [{ type: 'tool_result' }] },
        { role: 'user', content: [{ type: 'unknown_block', foo: 1 }] },
        { role: 'user', content: [{ type: 'text' }] },
      ],
    });
    const msgs = withToolResult.messages as unknown[];
    expect(msgs[0]).toMatchObject({ role: 'tool' });
    expect(msgs[1]).toMatchObject({ role: 'tool', content: 'blk' });
    expect(msgs[2]).toMatchObject({ role: 'tool' });
    // 非对象请求防御
    expect(() => claude.claudeRequestToChat('junk')).not.toThrow();
    expect(() => claude.claudeRequestToChat({ messages: [null] })).not.toThrow();
  });

  it('chatRequestToClaude：system 提取、tool_calls 消息还原 tool_use、max_tokens 默认', () => {
    const out = claude.chatRequestToClaude({
      model: 'm',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    });
    expect(out.system).toBe('sys');
    expect(out.max_tokens).toBe(claude.DEFAULT_CLAUDE_MAX_TOKENS);
    // assistant tool_calls 与 tool 结果按 claude 协议还原（tool_use/tool_result 块）
    const flat = JSON.stringify(out.messages);
    expect(flat).toContain('tool_use');
    expect(flat).toContain('f');
    expect(flat).toContain('tool_result');
    // 坏形状防御
    expect(() => claude.chatRequestToClaude({ model: 'm', messages: [{ role: 'weird' }, null] })).not.toThrow();
  });

  it('claudeResponseToChat / claudeUpstreamToCanonicalStream：坏块与缺 usage 兜底', async () => {
    const res = claude.claudeResponseToChat({ content: [{ type: 'text' }, { type: 'tool_use', input: { a: 1 } }, null], usage: null });
    expect(res.choices).toBeDefined();
    const out = await new Response(claude.claudeUpstreamToCanonicalStream(sse([
      { type: 'message_start', message: null },
      { type: 'content_block_delta', delta: { type: 'text_delta' } },
      { type: 'content_block_delta', delta: null },
      { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 'bad' } },
      'not-json',
      { type: 'message_stop' },
    ]))).text();
    expect(out).toContain('[DONE]');
  });

  it('canonicalStreamToClaudeStream：无 id 的 tool_call 默认 id；缺 finish 正常收尾', async () => {
    const out = await new Response(claude.canonicalStreamToClaudeStream(sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'f', arguments: '' } }] }, finish_reason: null }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: {} }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: null }], usage: { completion_tokens: 2 } },
      '[DONE]',
    ]), 'm')).text();
    expect(out).toContain('"id":"toolu_0"');
    expect(out).toContain('message_stop');
  });
});

describe('gemini codec 防御矩阵', () => {
  it('geminiRequestToChat：systemInstruction 坏形状、functionCall/Response 坏参数、非对象 part', () => {
    const out = gemini.geminiRequestToChat({
      systemInstruction: { parts: [{ text: 'sys' }, { nope: 1 }] },
      contents: [
        { role: 'user', parts: [{ text: 'hi' }, { functionCall: { name: 'f', args: { k: 1 } } }, { functionCall: { name: 'g', args: 'bad' } }, null] },
        { role: 'model', parts: [{ functionResponse: { name: 'f', response: { r: 1 } } }] },
        null,
      ],
    }, 'm');
    expect((out.messages as unknown[])[0]).toMatchObject({ role: 'system', content: 'sys' });
    expect(() => gemini.geminiRequestToChat('junk', 'm')).not.toThrow();
  });

  it('chatRequestToGemini：tool 定义与 tool 消息还原 functionResponse；toolConfig auto', () => {
    const out = gemini.chatRequestToGemini({
      model: 'm',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c', content: 'ok' },
      ],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object' } } }, null],
      tool_choice: 'auto',
    } as never);
    expect(out.tools).toBeDefined();
    expect(out.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  it('geminiUpstreamToCanonicalStream：坏帧/缺 finishReason/usage 坏类型', async () => {
    const out = await new Response(gemini.geminiUpstreamToCanonicalStream(sse([
      { candidates: [{ content: { parts: [null, { nope: 1 }] } }] },
      { candidates: [{ content: {}, finishReason: null }], usageMetadata: { promptTokenCount: 'x' } },
      'not-json',
      { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
    ]), 'm')).text();
    expect(out).toContain('"content":"ok"');
    expect(out).toContain('[DONE]');
  });

  it('canonicalStreamToGeminiStream：坏帧跳过、工具调用增量、无 finish 收尾', async () => {
    const out = await new Response(gemini.canonicalStreamToGeminiStream(sse([
      'not-json',
      { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: null }], usage: { completion_tokens: 1 } },
    ]), 'm')).text();
    expect(out).toContain('"text":"x"');
  });
});

describe('responses / completions codec 防御矩阵', () => {
  it('responsesRequestToChat：input 数组多形态（文本/坏项）、max_output_tokens 映射', () => {
    const out = responses.responsesRequestToChat({
      model: 'm',
      instructions: '',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] }, { type: 'junk' }, null],
      max_output_tokens: 99,
    });
    expect(out.max_tokens).toBe(99);
    expect(() => responses.responsesRequestToChat({ model: 'm', input: [{ role: 5 }] })).not.toThrow();
  });

  it('canonicalStreamToResponsesStream：错误帧 → response.failed；created 延迟；usage 帧', async () => {
    const out = await new Response(responses.canonicalStreamToResponsesStream(sse([
      { error: { code: 'x', message: 'boom' } },
    ]))).text();
    expect(out).toContain('response.failed');
    const ok = await new Response(responses.canonicalStreamToResponsesStream(sse([
      { choices: [{ delta: { content: 'a' }, finish_reason: null }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      'not-json',
    ]))).text();
    expect(ok).toContain('response.output_text.delta');
    expect(ok).toContain('response.completed');
  });

  it('completionsRequestToChat：prompt 数组混合元素 + system 字段', () => {
    const out = completions.completionsRequestToChat({
      model: 'm', system: 's',
      prompt: ['a ', ['b'], 'c'],
    });
    expect(out.messages as unknown[]).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'a bc' },
    ]);
  });
});
