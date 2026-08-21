import { describe, expect, it } from 'vitest';
import * as claude from '../../src/protocol/claude-chat.js';
import * as gemini from '../../src/protocol/gemini-chat.js';

/**
 * 垃圾形态机枪：每个字段依次置为错型（number/null/array/object）灌进全部入口——
 * 防御臂（str/asJson/asArray 的 else 路径）是 codec 的行为契约：坏形状必须不抛、
 * 缺省必须兜底。断言只锚「不抛 + 返回可序列化结果」。
 */
const JUNK = [42, null, [], { weird: true }, '', [null, 42, { a: 1 }], true];

const withJunkAt = (base: () => Record<string, unknown>, field: string, value: unknown) => {
  const obj = base();
  obj[field] = value;
  return obj;
};

const chatBase = () => ({
  model: 'm',
  messages: [{ role: 'user', content: 'hi' }],
});
const claudeBase = () => ({
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  max_tokens: 16,
});
const geminiBase = () => ({
  contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
});
const streamFrames = () => [
  { id: 'c', choices: [{ index: 0, delta: { content: 'x' }, finish_reason: null }] },
  { id: 'c', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  '[DONE]',
];
const claudeEvents = () => [
  { type: 'message_start', message: { model: 'm', id: 'i', usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];
const geminiEvents = () => [
  { candidates: [{ content: { parts: [{ text: 'a' }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } },
];

function toStream(frames: unknown[]): ReadableStream<Uint8Array> {
  let i = 0;
  const payload = frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f)));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= payload.length) {
        controller.close();
        return;
      }
      controller.enqueue(new TextEncoder().encode(`data: ${payload[i++]!}\n\n`));
    },
  });
}

const FIELDS = ['model', 'messages', 'system', 'max_tokens', 'temperature', 'top_p', 'stop_sequences', 'stream', 'tools', 'tool_choice', 'content', 'role', 'usage'];

describe('claude codec 垃圾形态机枪', () => {
  it('claudeRequestToChat：每字段 × 每错型不抛且可序列化', () => {
    for (const field of FIELDS) {
      for (const junk of JUNK) {
        const out = claude.claudeRequestToChat(withJunkAt(claudeBase, field, junk));
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
    expect(() => JSON.stringify(claude.claudeRequestToChat(null))).not.toThrow();
  });

  it('chatRequestToClaude：每字段 × 每错型不抛', () => {
    for (const field of FIELDS) {
      for (const junk of JUNK) {
        const out = claude.chatRequestToClaude(withJunkAt(chatBase, field, junk));
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
    // 消息条目本身为垃圾
    expect(() => JSON.stringify(claude.chatRequestToClaude({ model: 'm', messages: [null, 42, 's'] }))).not.toThrow();
  });

  it('claudeResponseToChat：usage/content/choices 错型不抛', () => {
    for (const junk of JUNK) {
      for (const field of ['usage', 'content', 'choices', 'stop_reason', 'model', 'id']) {
        const out = claude.claudeResponseToChat(withJunkAt(() => ({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }), field, junk));
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
  });

  it('双向流转换：事件字段错型不抛且输出可解析', async () => {
    for (const junk of JUNK) {
      const events = claudeEvents().map((e, i) => (i === 1 ? { ...e, content_block: junk } : i === 2 ? { ...e, delta: junk } : e));
      const canonical = await new Response(claude.claudeUpstreamToCanonicalStream(toStream(events))).text();
      expect(canonical).toContain('[DONE]');
      const out = await new Response(claude.canonicalStreamToClaudeStream(toStream(streamFrames().map((f, i) => (i === 0 && typeof f !== 'string' ? { ...f, choices: [{ ...f.choices[0], delta: junk }] } : f))), 'm')).text();
      expect(out).toContain('message_stop');
    }
  });
});

describe('gemini codec 垃圾形态机枪', () => {
  const G_FIELDS = ['contents', 'systemInstruction', 'generationConfig', 'tools', 'toolConfig', 'parts', 'role', 'usageMetadata', 'candidates', 'finishReason'];

  it('geminiRequestToChat：每字段 × 每错型不抛', () => {
    for (const field of G_FIELDS) {
      for (const junk of JUNK) {
        const out = gemini.geminiRequestToChat(withJunkAt(geminiBase, field, junk), 'm');
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
    expect(() => JSON.stringify(gemini.geminiRequestToChat(null, 'm'))).not.toThrow();
  });

  it('chatRequestToGemini：每字段 × 每错型不抛', () => {
    for (const field of [...FIELDS, 'tools', 'tool_choice']) {
      for (const junk of JUNK) {
        const out = gemini.chatRequestToGemini(withJunkAt(chatBase, field, junk));
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
    expect(() => JSON.stringify(gemini.chatRequestToGemini({ model: 'm', messages: [null, 3] }))).not.toThrow();
  });

  it('geminiResponseToChat：candidates/usageMetadata 错型不抛', () => {
    for (const junk of JUNK) {
      for (const field of ['candidates', 'usageMetadata', 'content', 'parts', 'finishReason']) {
        const out = gemini.geminiResponseToChat(
          withJunkAt(() => ({ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), field, junk),
          'm',
        );
        expect(() => JSON.stringify(out)).not.toThrow();
      }
    }
  });

  it('双向流转换：事件字段错型不抛', async () => {
    for (const junk of JUNK) {
      const events = geminiEvents().map((e, i) => (i === 0 ? { ...e, usageMetadata: junk } : e));
      const canonical = await new Response(gemini.geminiUpstreamToCanonicalStream(toStream(events), 'm')).text();
      expect(canonical).toContain('[DONE]');
      const encode = await new Response(gemini.canonicalStreamToGeminiStream(toStream(streamFrames()), 'm')).text();
      expect(encode.length).toBeGreaterThan(0);
    }
  });
});
