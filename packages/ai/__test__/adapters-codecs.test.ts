import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { DashScopeAdapter } from '../src/adapters/dashscope.js';
import { claudeRequestToChat, chatRequestToClaude, claudeUpstreamToCanonicalStream } from '../src/protocol/claude-chat.js';
import { geminiResponseToChat, geminiUpstreamToCanonicalStream } from '../src/protocol/gemini-chat.js';
import { chatResponseToCompletions } from '../src/protocol/completions-chat.js';
import { mergeParamRules } from '../src/registry/vendor-profiles.js';

const oc = new OpenAICompatibleAdapter();
const ch = { baseUrl: 'https://x.test', apiKey: 'k', protocol: 'openai-compatible' };

describe('openai-compatible：参数抹平引擎（S5 端点词表回归）', () => {
  it('ignore/clamp/map 全动作 + adjustments 留痕', () => {
    const { body, adjustments } = oc.normalizeRequest(
      { model: 'm', messages: [], temperature: 3, max_tokens: 99999, store: true },
      { ignore: ['store'], clamp: { temperature: { max: 2 }, max_completion_tokens: { max: 8192 } }, map: { max_tokens: { to: 'max_completion_tokens' } } },
      'chat',
    );
    expect((body as Record<string, unknown>).store).toBeUndefined();
    expect((body as Record<string, unknown>).temperature).toBe(2);
    expect((body as Record<string, unknown>).max_completion_tokens).toBe(8192);
    expect((body as Record<string, unknown>).max_tokens).toBeUndefined();
    expect(adjustments.length).toBe(4);
  });
  it('S5 回归：unknown drop 在 embeddings 端点保留 input/dimensions（v1 会删）', () => {
    const { body } = oc.normalizeRequest(
      { model: 'm', input: ['a', 'b'], dimensions: 256, temperature: 1 },
      { unknown: 'drop' },
      'embeddings',
    );
    const b = body as Record<string, unknown>;
    expect(b.input).toEqual(['a', 'b']);
    expect(b.dimensions).toBe(256);
    expect(b.temperature).toBe(1); // chat 词表也含
  });
  it('unknown drop 在 images 端点保留 n/quality', () => {
    const { body } = oc.normalizeRequest({ model: 'm', prompt: 'p', n: 2, quality: 'hd' }, { unknown: 'drop' }, 'images');
    expect((body as Record<string, unknown>).n).toBe(2);
    expect((body as Record<string, unknown>).quality).toBe('hd');
  });
  it('unknown passthrough 默认：wire 保真', () => {
    const { body } = oc.normalizeRequest({ model: 'm', vendor_private: 'x' }, {}, 'chat');
    expect((body as Record<string, unknown>).vendor_private).toBe('x');
  });
  it('finalizeRequestBody：model 重写 + stream_options 强制注入', () => {
    const b = oc.finalizeRequestBody({ model: 'ext', messages: [] }, { endpoint: 'chat', model: 'real', stream: true });
    expect(b.model).toBe('real');
    expect((b.stream_options as Record<string, unknown>).include_usage).toBe(true);
  });
  it('寻址：endpoint → 路径表', () => {
    expect(oc.planRequest(ch, { endpoint: 'chat', model: 'm', requestId: 'r', stream: true }).path).toContain('chat/completions');
    expect(oc.planRequest(ch, { endpoint: 'embeddings', model: 'm', requestId: 'r', stream: false }).path).toContain('embeddings');
    expect(oc.supportedEndpoints).toContain('images');
  });
});

describe('错误表：adapter kind 翻译（§4.3 表驱动）', () => {
  it('anthropic：authentication_error → invalid_api_key（死凭据派生）；overloaded_error → overloaded', () => {
    const a = new AnthropicAdapter();
    const e1 = a.mapError(401, { type: 'error', error: { type: 'authentication_error', message: 'x' } });
    expect(e1.kind).toBe('invalid_api_key');
    expect(e1.deadCredential).toBe(true);
    const e2 = a.mapError(529, { error: { type: 'overloaded_error' } });
    expect(e2.kind).toBe('overloaded');
    expect(e2.retryable).toBe(true);
  });
  it('gemini：RESOURCE_EXHAUSTED → rate_limited；UNAUTHENTICATED → invalid_api_key', () => {
    const g = new GeminiAdapter();
    expect(g.mapError(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }).kind).toBe('rate_limited');
    expect(g.mapError(401, { error: { code: 401, status: 'UNAUTHENTICATED' } }).kind).toBe('invalid_api_key');
  });
  it('minimax 信封：1004 → invalid_api_key；1008 → quota_exhausted；HTTP 200 信封错误也命中', () => {
    const m = new MiniMaxAdapter();
    expect(m.mapError(200, { base_resp: { status_code: 1004, status_msg: 'bad key' } }).kind).toBe('invalid_api_key');
    expect(m.mapError(200, { base_resp: { status_code: 1008 } }).kind).toBe('quota_exhausted');
    expect(m.mapError(200, { base_resp: { status_code: 0 } }).kind).toBe('invalid_request'); // 0 = 无错误落 200 兜底
  });
  it('dashscope：Throttling → rate_limited；Arrearage → quota_exhausted', () => {
    const d = new DashScopeAdapter();
    expect(d.mapError(429, { code: 'Throttling.RequestQPS', message: 'x' }).kind).toBe('rate_limited');
    expect(d.mapError(403, { code: 'Arrearage', message: '欠费' }).kind).toBe('quota_exhausted');
  });
  it('B4 回归：vertex extractUsage 翻译后 OpenAI 形兜底（v1 恒 null）', () => {
    const v = new VertexAiAdapter();
    expect(v.extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })).toMatchObject({ inputTokens: 7, outputTokens: 3 });
    expect(v.extractUsage({ usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } })).toMatchObject({ inputTokens: 5, outputTokens: 2 });
  });
});

describe('protocol/claude-chat：四方向 codec', () => {
  it('入站请求：system/messages/tool_result/tool_use 映射', () => {
    const chat = claudeRequestToChat({ model: 'c', system: 'sys', max_tokens: 100, messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'f', input: { a: 1 } }] },
    ] });
    const msgs = chat.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'sys' });
    expect(msgs[1]).toMatchObject({ role: 'tool', tool_call_id: 't1' });
    expect((((msgs[3] ?? {}) as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({ function: { name: 'f', arguments: '{"a":1}' } });
  });
  it('出站请求：system 合并 / tool 消息转 tool_result / model 必填', () => {
    const cl = chatRequestToClaude({ model: 'm', messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'q' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'r' },
    ] });
    expect(cl.system).toBe('S');
    expect(cl.model).toBe('m');
    expect(cl.max_tokens).toBeGreaterThan(0); // Claude 必填默认
    const clMsgs = cl.messages as Array<{ content: Array<{ type: string }> }>;
    expect((clMsgs[1] ?? { content: [] }).content.some((b) => b.type === 'tool_use')).toBe(true);
    expect((clMsgs[2] ?? { content: [] }).content[0]?.type).toBe('tool_result');
  });
  it('流式：claude SSE → 规范形；usage 宽松解析（message_delta 只带 output）+ flush 兜底', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"c","usage":{"input_tokens":10,"cache_read_input_tokens":4}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join('');
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); },
    });
    const out = await new Response(claudeUpstreamToCanonicalStream(stream)).text();
    expect(out).toContain('"content":"你好"');
    expect(out).toContain('"finish_reason":"stop"');
    // 口径：prompt_tokens 含缓存读（10 未缓存 + 4 cached = 14，模块头注释口径）
    expect(out).toContain('"prompt_tokens":14');
    expect(out).toContain('"cached_tokens":4');
    expect(out).toContain('"completion_tokens":6');
    expect(out).toContain('[DONE]');
    expect(out.match(/\[DONE\]/g)?.length).toBe(1); // 单一哨兵（双 DONE 已修）
  });
});

describe('protocol/gemini + completions：bug 回归', () => {
  it('B2 回归：gemini 流式尾帧 usage 带 cached_tokens（v1 丢失）', async () => {
    const frames = [
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":8,"cachedContentTokenCount":5,"candidatesTokenCount":2}}\n\n',
      'data: {"candidates":[{"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"cachedContentTokenCount":5,"candidatesTokenCount":3}}\n\n',
    ].join('');
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(frames)); c.close(); } });
    const out = await new Response(geminiUpstreamToCanonicalStream(stream)).text();
    expect(out).toContain('"prompt_tokens":8');
    expect(out).toContain('"cached_tokens":5');
    expect(out).toContain('"completion_tokens":3');
  });
  it('B7 回归：completions n>1 全 choice 返回（v1 只取 choices[0]）', () => {
    const res = chatResponseToCompletions({ id: 'x', choices: [
      { index: 0, message: { content: 'a' }, finish_reason: 'stop' },
      { index: 1, message: { content: 'b' }, finish_reason: 'stop' },
    ], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
    const choices = res.choices as Array<{ text: string }>;
    expect(choices.length).toBe(2);
    expect(choices[1]?.text).toBe('b');
  });
  it('gemini 非流式：cached 扣出 input、thoughts 计入 output', () => {
    const u = (geminiResponseToChat({ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: { promptTokenCount: 10, cachedContentTokenCount: 3, thoughtsTokenCount: 2, candidatesTokenCount: 4 } }, 'm') as { usage?: Record<string, unknown> }).usage;
    expect(u?.prompt_tokens).toBe(10);
    expect((u?.prompt_tokens_details as Record<string, unknown>)?.cached_tokens).toBe(3);
    expect(u?.completion_tokens).toBe(6);
  });
});

describe('registry/vendor-profiles：规则合并', () => {
  it('ignore 并集、clamp 逐键 model 胜出、unknown model 优先', () => {
    const merged = mergeParamRules({ ignore: ['a'], clamp: { t: { max: 1 } }, unknown: 'passthrough' }, { ignore: ['b'], clamp: { t: { max: 9 } }, unknown: 'drop' });
    expect(merged.ignore).toEqual(['a', 'b']);
    expect(merged.clamp?.t?.max).toBe(9);
    expect(merged.unknown).toBe('drop');
  });
  it('undefined 两侧容忍', () => {
    expect(mergeParamRules(undefined, { ignore: ['x'] })?.ignore).toEqual(['x']);
    expect(mergeParamRules({ ignore: ['x'] }, undefined)?.ignore).toEqual(['x']);
  });
});
