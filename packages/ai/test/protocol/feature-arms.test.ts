import { describe, expect, it } from 'vitest';
import * as claude from '../../src/protocol/claude-chat.js';
import * as gemini from '../../src/protocol/gemini-chat.js';

/** 特性臂正例矩阵：generationConfig/toolConfig/工具消息/流式工具块等正向路径 */
const enc = (s: string) => new TextEncoder().encode(s);
function toStream(frames: unknown[]): ReadableStream<Uint8Array> {
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
}
const drain = (s: ReadableStream<Uint8Array>) => new Response(s).text();

describe('gemini 解码特性臂', () => {
  it('functionResponse → tool 消息；assistant functionCall → tool_calls；generationConfig 全参数', () => {
    const out = gemini.geminiRequestToChat({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ functionCall: { name: 'f', args: { a: 1 } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'f', response: { ok: 1 } } }] },
        { role: 'user', parts: [{ text: 'x' }, { functionResponse: { name: 'g', response: { v: 2 } } }] },
      ],
      generationConfig: { maxOutputTokens: 9, temperature: 0.1, topP: 0.8, stopSequences: ['s1', 2], responseMimeType: 'application/json' },
      tools: [{ functionDeclarations: [{ name: 'f', description: 'd', parameters: { type: 'object' } }, { name: 'g', parametersSchema: { type: 'object' } }] }, null],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } },
    }, 'm');
    expect(out).toMatchObject({
      max_tokens: 9, temperature: 0.1, top_p: 0.8, stop: ['s1', '2'],
      response_format: { type: 'json_object' },
      tool_choice: { type: 'function', function: { name: 'f' } },
    });
    expect(JSON.stringify(out)).toContain('"tool_calls"');
    expect(JSON.stringify(out)).toContain('"role":"tool"');
    expect(out.tools).toHaveLength(2);
    // AUTO 形态
    const auto = gemini.geminiRequestToChat({ contents: [], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } }, 'm');
    expect(auto.tool_choice).toBe('auto');
  });

  it('geminiResponseToChat：assistant functionCall part → tool_calls；SAFETY finish', () => {
    const out = gemini.geminiResponseToChat({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'fn', args: {} } }] }, finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
    }, 'm');
    expect(JSON.stringify(out)).toContain('"tool_calls"');
    expect((out.choices as unknown[])[0]).toMatchObject({ finish_reason: 'content_filter' });
  });
});

describe('claude 编码特性臂（chat → claude 上游方向）', () => {
  it('system 多条拼接、temperature/stop 映射、tools OpenAI 形→claude 形、tool_choice 三态', () => {
    const out = claude.chatRequestToClaude({
      model: 'm',
      messages: [
        { role: 'system', content: 's1' },
        { role: 'user', content: 'hi' },
        { role: 'system', content: 's2' },
      ],
      temperature: 0.3,
      stop: ['stop1'],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'required',
    } as never);
    expect(out.system).toBe('s1\ns2');
    expect(out.temperature).toBe(0.3);
    expect(out.stop_sequences).toEqual(['stop1']);
    expect(out.tools).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object' } }]);
    expect(out.tool_choice).toEqual({ type: 'any' });
    const auto = claude.chatRequestToClaude({ model: 'm', messages: [], tool_choice: 'auto' } as never);
    expect(auto.tool_choice).toEqual({ type: 'auto' });
    const named = claude.chatRequestToClaude({ model: 'm', messages: [], tool_choice: { type: 'function', function: { name: 'fn' } } } as never);
    expect(named.tool_choice).toEqual({ type: 'tool', name: 'fn' });
    const noMax = claude.chatRequestToClaude({ model: 'm', messages: [] } as never);
    expect(noMax.max_tokens).toBe(claude.DEFAULT_CLAUDE_MAX_TOKENS);
  });

  it('claudeResponseToChat：max_tokens/stop_sequence 映射、未知 stop_reason → stop', () => {
    const lengthStop = claude.claudeResponseToChat({ content: [], stop_reason: 'max_tokens', usage: { input_tokens: 1, output_tokens: 2 } }) as { choices: unknown[] };
    expect(lengthStop.choices[0]).toMatchObject({ finish_reason: 'length' });
    const weird = claude.claudeResponseToChat({ content: [], stop_reason: 'bizarre' }) as { choices: unknown[] };
    expect(weird.choices[0]).toMatchObject({ finish_reason: 'stop' });
    const none = claude.claudeResponseToChat({ content: [] }) as { choices: unknown[] };
    expect(none.choices[0]).toMatchObject({ finish_reason: null });
  });

  it('上游流：tool_use 块 start/delta → tool_calls 增量；usage message_delta 补全', async () => {
    const out = await drain(claude.claudeUpstreamToCanonicalStream(toStream([
      { type: 'message_start', message: { model: 'm', id: 'i', usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'fn' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])));
    expect(out).toContain('"tool_calls"');
    expect(out).toContain('tu1');
    expect(out).toContain('"finish_reason":"tool_calls"');
    expect(out).toContain('[DONE]');
  });
});

describe('claude 编码流特性臂', () => {
  it('canonical → claude：多 tool_call 槽位（index>0）与无内容收尾、usage 帧无 finish', async () => {
    const out = await drain(claude.canonicalStreamToClaudeStream(toStream([
      { id: 'c', choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }] },
      { id: 'c', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'g', arguments: '{}' } }] }, finish_reason: null }] },
      { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
      '[DONE]',
    ]), 'm'));
    expect(out).toContain('"index":2'); // 第二个 tool 槽位（0=文本，1+ = 工具）
    expect(out).toContain('"name":"g"');
    expect(out).toContain('message_stop');
  });
});
