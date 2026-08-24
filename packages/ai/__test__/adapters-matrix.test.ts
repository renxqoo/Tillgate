import { describe, expect, it } from 'vitest';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { DashScopeAdapter } from '../src/adapters/dashscope.js';
import { AzureOpenAIAdapter } from '../src/adapters/azure-openai.js';
import { chatRequestToClaude, claudeResponseToChat } from '../src/protocol/claude-chat.js';
import { canonicalStreamToClaudeStream } from '../src/protocol/claude-stream.js';
import { chatRequestToGemini } from '../src/protocol/gemini-chat.js';
import { canonicalStreamToGeminiStream } from '../src/protocol/gemini-stream.js';
import {
  completionsRequestToChat,
  canonicalStreamToCompletionsStream,
} from '../src/protocol/completions-chat.js';
import { normalizeUsage } from '../src/usage/normalize.js';
import { defined } from './defined';

const ch = (baseUrl = 'https://x.test', protocol = 'openai-compatible') => ({
  baseUrl,
  apiKey: 'k',
  protocol,
});
const pi = { endpoint: 'chat' as const, model: 'm', requestId: 'r', stream: false };

describe('adapter 寻址矩阵', () => {
  const oc = new OpenAICompatibleAdapter();
  it('openai-compatible 全端点路径', () => {
    expect(oc.planRequest(ch(), { ...pi, stream: true }).path).toBe('/v1/chat/completions');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'embeddings' }).path).toBe('/v1/embeddings');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'images' }).path).toBe('/v1/images/generations');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'images_edits' }).path).toBe('/v1/images/edits');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'audio_speech' }).path).toBe('/v1/audio/speech');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'audio_transcription' }).path).toBe(
      '/v1/audio/transcriptions',
    );
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'audio_translation' }).path).toBe(
      '/v1/audio/translations',
    );
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'rerank' }).path).toBe('/v1/rerank');
    expect(oc.planRequest(ch(), { ...pi, endpoint: 'moderations' }).path).toBe('/v1/moderations');
    expect(oc.planRequest(ch(), { ...pi }).headers.authorization).toBe('Bearer k');
    expect(oc.probeRequests(ch())[0]?.path).toBe('/v1/models');
  });
  it('anthropic：/v1/messages + x-api-key + version 头；流式 query', () => {
    const a = new AnthropicAdapter();
    const p = a.planRequest(ch('https://x.test', 'anthropic'), { ...pi, stream: true });
    expect(p.path).toBe('/v1/messages');
    expect(p.headers['x-api-key']).toBe('k');
    expect(p.headers['anthropic-version']).toBeDefined();
  });
  it('gemini：model 进 path + alt=sse；key 进 query 头', () => {
    const g = new GeminiAdapter();
    const p = g.planRequest(ch('https://x.test', 'gemini'), { ...pi, stream: true });
    expect(p.path).toContain('/models/m:streamGenerateContent');
    expect(p.path).toContain('alt=sse');
    expect(g.planRequest(ch('https://x.test', 'gemini'), { ...pi, stream: false }).path).toContain(
      ':generateContent',
    );
  });
  it('vertex：model 进 path 且 baseUrl 保持区域前缀', () => {
    const v = new VertexAiAdapter();
    const p = v.planRequest(ch('https://us-central1-aiplatform.googleapis.com', 'vertex-ai'), {
      ...pi,
      stream: false,
    });
    expect(p.path).toContain('/models/m:generateContent');
    expect(v.supportedEndpoints).toEqual(['chat']);
  });
  it('azure：部署制路径 + api-key 头 + api-version query', () => {
    const p = AzureOpenAIAdapter.planRequest(ch('https://x.openai.azure.com', 'azure-openai'), pi);
    expect(p.path).toContain('/openai/deployments/m/chat/completions');
    expect(p.path).toContain('api-version=');
    expect(p.headers['api-key']).toBe('k');
  });
  it('minimax：video/music 任务族寻址', () => {
    const m = new MiniMaxAdapter();
    const t = defined(m.tasks, 'm.tasks');
    expect(t.planTaskQuery(ch('https://x.test', 'minimax'), 'tid').path).toContain('task_id=tid');
    expect(t.planFileRetrieve(ch('https://x.test', 'minimax'), 'fid').path).toContain(
      'file_id=fid',
    );
    expect(m.supportedEndpoints).toContain('video');
  });
  it('dashscope：images 原生 / compatible-mode chat 双面', () => {
    const d = new DashScopeAdapter();
    expect(
      d.planRequest(ch('https://x.test', 'dashscope'), { ...pi, endpoint: 'images' }).path,
    ).toContain('multimodal-generation');
    expect(
      d.planRequest(ch('https://x.test', 'dashscope'), { ...pi, endpoint: 'chat' }).path,
    ).toContain('compatible-mode');
    expect(
      d.planRequest(ch('https://x.test', 'dashscope'), { ...pi, endpoint: 'embeddings' }).path,
    ).toContain('compatible-mode/v1/embeddings');
  });
});

describe('adapter usage/error 补充分支', () => {
  it('anthropic extractUsage：规范形优先 + claude 形兜底', () => {
    const a = new AnthropicAdapter();
    expect(a.extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 2 } })).toMatchObject({
      inputTokens: 5,
    });
    expect(
      a.extractUsage({ usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 1 } }),
    ).toMatchObject({ inputTokens: 6, cachedInputTokens: 1 });
    expect(a.extractUsage({})).toBeNull();
    expect(a.extractUsage(null)).toBeNull();
  });
  it('gemini extractUsage 双形 + minimax 任务状态解析', () => {
    const g = new GeminiAdapter();
    expect(
      g.extractUsage({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }),
    ).toMatchObject({ inputTokens: 3 });
    expect(g.extractUsage({ usage: { prompt_tokens: 9, completion_tokens: 1 } })).toMatchObject({
      inputTokens: 9,
    });
    const m = new MiniMaxAdapter();
    const st = defined(m.tasks, 'm.tasks').parseTaskStatus({ status: 'Success', file_id: 'f1' });
    expect(st).toMatchObject({ ok: true, status: 'succeeded', fileId: 'f1' });
    expect(defined(m.tasks, 'm.tasks').parseTaskStatus({ status: 'Fail' })).toMatchObject({
      ok: true,
      status: 'failed',
    });
    expect(defined(m.tasks, 'm.tasks').parseTaskStatus({ status: 'Unknown' })).toMatchObject({
      ok: true,
      status: 'running',
    });
    expect(
      defined(m.tasks, 'm.tasks').parseFileRetrieve({ file: { download_url: 'https://cdn/x' } }),
    ).toMatchObject({
      ok: true,
      downloadUrl: 'https://cdn/x',
    });
  });
});

describe('codec 反向流（客户端面）', () => {
  it('canonical → claude SSE：合成 message_start/delta/stop + usage 还原', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(
      canonicalStreamToClaudeStream(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(frames));
            c.close();
          },
        }),
        'm',
      ),
    ).text();
    expect(out).toContain('event: message_start');
    expect(out).toContain('event: content_block_delta');
    expect(out).toContain('event: message_stop');
    expect(out).toContain('"input_tokens":3');
    expect(out).toContain('"output_tokens":2');
  });
  it('canonical → gemini SSE：finish/usage 映射', async () => {
    const frames = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const out = await new Response(
      canonicalStreamToGeminiStream(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(frames));
            c.close();
          },
        }),
        'm',
      ),
    ).text();
    expect(out).toContain('"finishReason":"STOP"');
    expect(out.toLowerCase()).toContain('usagemetadata');
  });
  it('completions 入站请求 → 规范形', () => {
    const chat = completionsRequestToChat({
      model: 'm',
      prompt: 'q',
      stream: true,
      temperature: 0.5,
    });
    expect((chat.messages as Array<Record<string, unknown>>)[0]).toMatchObject({
      role: 'user',
      content: 'q',
    });
    expect(chat.stream).toBe(true);
  });
  it('completions 入站流 → 规范形流出站', async () => {
    const frames = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    const out = await new Response(
      canonicalStreamToCompletionsStream(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(frames));
            c.close();
          },
        }),
      ),
    ).text();
    expect(out).toContain('"text":"ok"');
    expect(out).toContain('[DONE]');
  });
  it('claude 非流式响应 + usage（含 cache）', () => {
    const r = claudeResponseToChat({
      id: 'm1',
      model: 'c',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3 },
    }) as Record<string, unknown>;
    expect((r.choices as Array<Record<string, unknown>>)[0]?.message).toMatchObject({
      content: 'hi',
    });
    const u = normalizeUsage(r.usage);
    expect(u).toMatchObject({ inputTokens: 8, cachedInputTokens: 3, outputTokens: 2 });
  });
  it('claude/gemini 请求出站：垃圾输入不崩（防御式守卫）', () => {
    expect(() => chatRequestToClaude(null)).not.toThrow();
    expect(() => chatRequestToClaude({ messages: 'not-array' })).not.toThrow();
    expect(() => chatRequestToGemini(null)).not.toThrow();
    expect(() => chatRequestToGemini({ contents: 'garbage' })).not.toThrow();
  });
});
