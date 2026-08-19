/**
 * 生产适配器绑定单测（stub Ai——绑定层映射，协议归一见 ai 包套件）：
 * upstream-adapter（解密注入/deadlineMs 透传/usage estimated 丢弃/错误归一）。
 * 任务适配器绑定与本地 mock 上游的端到端在 smoke 套件。
 */
import { describe, expect, it } from 'vitest';
import { encrypt } from '@ai-gateway/core';
import type { Ai } from '@ai-gateway/ai';
import { createUpstreamAdapter } from '../upstream-adapter.js';
import type { RouteCandidateRow } from '@ai-gateway/repository';

const encryptionKey = 'bind-test-key-0123456789abcdef';

const candidate: RouteCandidateRow = {
  channelId: 1, channelName: 'ch', apiKeyEnc: encrypt('sk-real', encryptionKey),
  baseUrlOverride: null, providerName: 'p', providerBaseUrl: 'https://up.test',
  providerProtocol: 'openai-compatible', priority: 1, weight: 1,
  rpmLimit: null, tpmLimit: null, upstreamBudget: '1000',
};

function stubAi(chatImpl: (input: { channel: { apiKey: string; baseUrl: string; protocol: string }; ctx?: { deadlineMs?: number } }) => Promise<unknown>): Ai {
  return { chat: chatImpl } as unknown as Ai;
}

describe('createUpstreamAdapter 绑定层', () => {
  it('apiKeyEnc 经 core.decrypt 解密注入 ChannelDesc；deadlineMs 透传 ai ctx', async () => {
    const seen: { apiKey?: string; baseUrl?: string; deadline?: number } = {};
    const adapter = createUpstreamAdapter({
      ai: stubAi(async (input) => {
        seen.apiKey = input.channel.apiKey;
        seen.baseUrl = input.channel.baseUrl;
        seen.deadline = input.ctx?.deadlineMs;
        return { status: 'success', body: { ok: 1 }, usage: { inputTokens: 3, cachedInputTokens: 0, outputTokens: 2, estimated: false } };
      }),
      encryptionKey,
      deadlineMs: 5_000,
    });
    const result = await adapter.chat(candidate, { requestId: 'r', realModel: 'm', externalModel: 'm', body: {} });
    expect(result).toMatchObject({ ok: true, usage: { inputTokens: 3 } });
    expect(seen.apiKey).toBe('sk-real');
    expect(seen.baseUrl).toBe('https://up.test');
    expect(seen.deadline).toBe(5_000);
  });

  it('usage estimated=true 视为缺 usage（估算归属政策在管线收据侧处理）', async () => {
    const adapter = createUpstreamAdapter({
      ai: stubAi(async () => ({
        status: 'success', body: {},
        usage: { inputTokens: 9, cachedInputTokens: 0, outputTokens: 9, estimated: true },
      })),
      encryptionKey,
    });
    const result = await adapter.chat(candidate, { requestId: 'r', realModel: 'm', externalModel: 'm', body: {} });
    expect(result.ok).toBe(true);
    expect((result as { usage?: unknown }).usage).toBeUndefined();
  });

  it('error 态但无 error 字段 → invalid_response 归一（不静默）', async () => {
    const adapter = createUpstreamAdapter({
      ai: stubAi(async () => ({ status: 'error' })),
      encryptionKey,
    });
    const result = await adapter.chat(candidate, { requestId: 'r', realModel: 'm', externalModel: 'm', body: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_response' } });
  });

  it('baseUrlOverride 优先于 provider 默认（渠道级指向）', async () => {
    const seen: { baseUrl?: string } = {};
    const adapter = createUpstreamAdapter({
      ai: stubAi(async (input) => {
        seen.baseUrl = input.channel.baseUrl;
        return { status: 'success', body: {} };
      }),
      encryptionKey,
    });
    await adapter.chat(
      { ...candidate, baseUrlOverride: 'https://override.test' },
      { requestId: 'r', realModel: 'm', externalModel: 'm', body: {} },
    );
    expect(seen.baseUrl).toBe('https://override.test');
  });

  it('上游错误：code/message/deadCredential 原样透传端口契约', async () => {
    const adapter = createUpstreamAdapter({
      ai: stubAi(async () => ({ status: 'error', error: { code: 'invalid_api_key', message: 'bad', deadCredential: true } })),
      encryptionKey,
    });
    const result = await adapter.chat(candidate, { requestId: 'r', realModel: 'm', externalModel: 'm', body: {} });
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_api_key', message: 'bad', deadCredential: true } });
  });
});
