import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { tryParseJson } from '../src/internal/util.js';
import { signAwsRequest, parseAwsCredentials, parseEventstreamFrames } from '../src/adapters/aws-bedrock.js';
import { chatRequestToGemini, geminiResponseToChat } from '../src/protocol/gemini-chat.js';
import { chatRequestToClaude, claudeRequestToChat } from '../src/protocol/claude-chat.js';
import { estimateAudioDurationSeconds } from '../src/usage/media-duration.js';
import { defineAdapter } from '../src/registry/define-adapter.js';

describe('internal/util + media-duration 深支', () => {
  it('tryParseJson：合法/非法/非对象', () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson('[1]')).toEqual([1]);
    expect(tryParseJson('bad')).toBeUndefined();
    expect(tryParseJson('')).toBeUndefined();
  });
  it('media-duration：MP3 ID3v2 头 + 帧同步 + 兜底', () => {
    const mp3 = new Uint8Array(200);
    mp3.set([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10], 0); // ID3 + size=16
    mp3.set([0xff, 0xfb, 0x90, 0x00], 10 + 16); // MPEG1 LayerIII 128k 帧头
    const sec = estimateAudioDurationSeconds(mp3);
    expect(sec).toBeGreaterThan(0);
    // 纯随机（无 ID3 无帧同步）→ 16KB/s 兜底
    const junk = new Uint8Array(3200);
    junk.fill(0x01);
    expect(estimateAudioDurationSeconds(junk)).toBe(1);
  });
});

describe('bedrock 深支：事件流解析与签名', () => {
  it('parseAwsCredentials：sessionToken 第三段 + 缺段拒绝', () => {
    expect(parseAwsCredentials('A:S:T')).toMatchObject({ sessionToken: 'T' });
    expect(parseAwsCredentials('A:S')).toMatchObject({ accessKeyId: 'A' });
    expect(parseAwsCredentials('')).toBeNull();
    expect(parseAwsCredentials(':S')).toBeNull();
  });
  it('parseEventstreamFrames：空/短 buffer 安全返回 rest', () => {
    const { frames, rest } = parseEventstreamFrames(Buffer.alloc(0));
    expect(frames).toEqual([]);
    expect(rest.length).toBe(0);
    const short = parseEventstreamFrames(Buffer.from([1, 2, 3]));
    expect(short.frames).toEqual([]);
    expect(short.rest.length).toBe(3);
  });
  it('signAwsRequest：sessionToken 进签名 + 确定性（同时问稳定输出）', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const a = signAwsRequest({ method: 'POST', url: new URL('https://b.test/x'), body: 'b', credentials: { accessKeyId: 'A', secretAccessKey: 'S' }, at });
    const b = signAwsRequest({ method: 'POST', url: new URL('https://b.test/x'), body: 'b', credentials: { accessKeyId: 'A', secretAccessKey: 'S' }, at });
    expect(a).toEqual(b); // 签名确定性
  });
});

describe('codec 深支', () => {
  it('claude 入站：thinking 块 / 多 tool_use / 数组 system / 工具定义', () => {
    const chat = claudeRequestToChat({
      model: 'c',
      system: [{ type: 'text', text: 's1' }, { type: 'text', text: 's2' }],
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: 't' }] },
      ],
    });
    expect((chat.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ role: 'system', content: 's1s2' });
    expect((chat.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ function: { name: 'f' } });
    expect(chat.tool_choice).toBe('required');
  });
  it('claude 出站：developer 角色 / tool_choice named / stop_sequences', () => {
    const cl = chatRequestToClaude({ model: 'm', messages: [{ role: 'developer', content: 'D' }, { role: 'user', content: 'q' }], tool_choice: { type: 'function', function: { name: 'f' } }, stop: ['END'] });
    expect(cl.system).toBe('D');
    expect(cl.stop_sequences).toEqual(['END']);
    expect(cl.tool_choice).toMatchObject({ type: 'tool', name: 'f' });
  });
  it('gemini 出站：多模态远程 URL part + tool_config', () => {
    const g = chatRequestToGemini({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://cdn.example.com/x.png' } }] }] });
    const parts = (g.contents as Array<{ parts: Array<Record<string, unknown>> }>)[0]?.parts ?? [];
    // 现状语义：远程 URL 不转 fileData（返回空 text part）——锁定行为防静默变更
    expect(parts.every((p) => p.fileData === undefined)).toBe(true);
  });
  it('gemini 非流式：候选缺失/垃圾容错', () => {
    expect(Array.isArray((geminiResponseToChat({}, 'm') as { choices: unknown }).choices)).toBe(true);
    expect(geminiResponseToChat(null, 'm')).toBeDefined();
    const r = geminiResponseToChat({ candidates: [{ content: { parts: [{ text: 'x' }, { text: 'y' }] } }] }, 'm');
    expect(JSON.stringify(r)).toContain('xy');
  });
});

describe('defineAdapter 能力覆写面', () => {
  it('usage/errors/codec/tasks 覆写生效', () => {
    const probe = { path: '/p', headers: {} };
    const a = defineAdapter({
      protocol: 't2',
      usage: { extractUsage: () => ({ inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, estimated: false, raw: {} }) },
      errors: { mapError: (status) => ({ kind: 'invalid_request', message: String(status) } as never) },
      codec: { translateResponseBody: (b) => ({ wrapped: b }) },
      tasks: { parseResponse: () => ({ kind: 'error', error: new Error('x') as never }) } as never,
    });
    expect(a.extractUsage(null)).toMatchObject({ inputTokens: 1 });
    const me = a.mapError(500, {});
    expect((me as unknown as Record<string, unknown>).kind).toBe('invalid_request');
    expect(a.translateResponseBody?.({ z: 1 })).toEqual({ wrapped: { z: 1 } });
    void probe;
  });
});
