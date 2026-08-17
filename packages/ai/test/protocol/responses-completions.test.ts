import { describe, expect, it } from 'vitest';
import {
  responsesRequestToChat,
  chatResponseToResponses,
  canonicalStreamToResponsesStream,
} from '../../src/protocol/responses-chat';
import {
  completionsRequestToChat,
  chatResponseToCompletions,
} from '../../src/protocol/completions-chat';

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

describe('responses ⇄ chat 入站 codec', () => {
  it('请求：input 数组 + instructions → chat messages', () => {
    const chat = responsesRequestToChat({
      model: 'gpt-5',
      instructions: 'You are terse.',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'Hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
      ],
      max_output_tokens: 300,
      temperature: 0.2,
    }) as Record<string, any>;
    expect(chat.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ]);
    expect(chat.max_tokens).toBe(300);
    expect(chat.temperature).toBe(0.2);
  });

  it('非流式：chat 响应 → responses 形', () => {
    const out = chatResponseToResponses({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-5',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }) as Record<string, any>;
    expect(out.object).toBe('response');
    expect(out.status).toBe('completed');
    expect(out.output[0].content[0].text).toBe('OK');
    expect(out.usage).toEqual({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  });

  it('流式：规范形 chunk → responses 事件序列（created/delta/completed）', async () => {
    const enc = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        const f = (o: unknown) => c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
        f({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
        f({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'Hey' }, finish_reason: null }] });
        f({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } });
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    const out = await streamToString(canonicalStreamToResponsesStream(upstream));
    expect(out).toContain('event: response.created');
    expect(out).toContain('event: response.output_item.added');
    expect(out).toContain('"delta":"Hey"');
    expect(out).toContain('event: response.output_text.done');
    expect(out).toContain('event: response.completed');
    expect(out).toContain('"input_tokens":2,"output_tokens":1');
  });
});

describe('completions（legacy）→ chat 入站 codec', () => {
  it('请求：prompt → user 消息，参数透传', () => {
    const chat = completionsRequestToChat({ model: 'gpt-3.5-turbo-instruct', prompt: 'Write a haiku', max_tokens: 64, temperature: 0.7 }) as Record<string, any>;
    expect(chat.messages).toEqual([{ role: 'user', content: 'Write a haiku' }]);
    expect(chat.max_tokens).toBe(64);
    expect(chat.temperature).toBe(0.7);
  });

  it('响应：chat → text_completion 形', () => {
    const out = chatResponseToCompletions({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 1700000001,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'lines here' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 6, completion_tokens: 9, total_tokens: 15 },
    }) as Record<string, any>;
    expect(out.object).toBe('text_completion');
    expect(out.choices[0].text).toBe('lines here');
    expect(out.choices[0].finish_reason).toBe('length');
  });
});
