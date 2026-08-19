/**
 * 生成任务适配器单测（stub Ai——协议归一分支）：
 * 提交（task_id/信封错误/无任务号）、代执行（产物/无产物）、
 * 三态查询（running/failed/succeeded-artifact/succeeded-fileId→二次换取）。
 */
import { describe, expect, it } from 'vitest';
import { createGenerationTaskAdapter } from '../src/generation/task-adapter.js';
import type { Ai, GenerationArtifact } from '../src/types.js';

type ChatResult =
  | { status: 'success'; body: Record<string, unknown>; usage?: unknown }
  | { status: 'error'; error: { code: string; message: string; deadCredential?: boolean } };

function stubAi(plan: {
  chat?: ChatResult;
  parse?: { kind: 'task_submitted'; taskId: string } | { kind: 'task_completed'; artifact: GenerationArtifact } | { kind: 'error'; error: { code: string; message: string; deadCredential?: boolean } };
  probe?: { ok: true; status: 'running' | 'succeeded' | 'failed'; fileId?: string; artifact?: GenerationArtifact; reason?: string } | { ok: false; error: { code: string; message: string } };
  file?: { ok: true; downloadUrl: string } | { ok: false; error: { code: string; message: string } };
  hasQuery?: boolean;
  hasFile?: boolean;
}): { ai: Ai; seenDeadline?: number | undefined; seenApiKey?: string } {
  const seen: { deadline?: number | undefined; apiKey?: string } = {};
  const ai = {
    chat: async (input: { channel: { apiKey: string }; ctx?: { deadlineMs?: number } }) => {
      seen.apiKey = input.channel.apiKey;
      seen.deadline = input.ctx?.deadlineMs;
      return plan.chat ?? { status: 'error', error: { code: 'unplanned', message: 'no chat plan' } };
    },
    parseGenerationResponse: () => plan.parse ?? { kind: 'error', error: { code: 'no_parse', message: 'unplanned' } },
    ...(plan.hasQuery === false ? {} : {
      queryGenerationTask: async () => plan.probe ?? { ok: true, status: 'running' },
    }),
    ...(plan.hasFile === false ? {} : {
      retrieveGenerationFile: async () => plan.file ?? { ok: false, error: { code: 'no_file', message: 'unplanned' } },
    }),
  } as unknown as Ai;
  return { ai, ...seen } as never;
}

const channel = {
  channelId: 1, channelName: 'ch', apiKeyEnc: 'enc-any',
  baseUrlOverride: null, providerName: 'p', providerBaseUrl: 'https://x.test', providerProtocol: 'openai-compatible',
} as const;
const decrypt = (enc: string) => `decrypted(${enc})`;

const adapterOf = (plan: Parameters<typeof stubAi>[0]) =>
  createGenerationTaskAdapter({ ai: stubAi(plan).ai, decrypt, encryptionKey: 'k' });

describe('createGenerationTaskAdapter', () => {
  it('submitTask：解密渠道密钥 + task_submitted 归一任务号', async () => {
    const { ai } = stubAi({ chat: { status: 'success', body: { task_id: 'up-1' } }, parse: { kind: 'task_submitted', taskId: 'up-1' } });
    const adapter = createGenerationTaskAdapter({ ai, decrypt, encryptionKey: 'k' });
    const result = await adapter.submitTask(channel, { requestId: 'r', realModel: 'm', externalModel: 'm', kind: 'video', body: {} });
    expect(result).toEqual({ ok: true, upstreamTaskId: 'up-1' });
  });

  it('submitTask：上游错误与「200 但无任务号」两路失败', async () => {
    const failing = adapterOf({ chat: { status: 'error', error: { code: 'invalid_api_key', message: 'bad key', deadCredential: true } } });
    const upstream = await failing.submitTask(channel, { requestId: 'r', realModel: 'm', externalModel: 'm', kind: 'video', body: {} });
    expect(upstream).toEqual({ ok: false, error: { code: 'invalid_api_key', message: 'bad key', deadCredential: true } });

    const unparsable = adapterOf({ chat: { status: 'success', body: {} }, parse: { kind: 'error', error: { code: 'envelope', message: 'x' } } });
    const noTask = await unparsable.submitTask(channel, { requestId: 'r', realModel: 'm', externalModel: 'm', kind: 'video', body: {} });
    expect(noTask).toMatchObject({ ok: false, error: { code: 'envelope' } });
  });

  it('executeTask：task_completed 归一产物；无产物失败', async () => {
    const ok = adapterOf({
      chat: { status: 'success', body: { audio: 'x' } },
      parse: { kind: 'task_completed', artifact: { url: 'https://cdn/a.mp3' } },
    });
    const done = await ok.executeTask(channel, { taskId: 't', realModel: 'm', kind: 'music', params: {} });
    expect(done).toEqual({ ok: true, artifact: { url: 'https://cdn/a.mp3' } });

    const bad = adapterOf({ chat: { status: 'success', body: {} }, parse: { kind: 'error', error: { code: 'e', message: 'no artifact' } } });
    const failed = await bad.executeTask(channel, { taskId: 't', realModel: 'm', kind: 'music', params: {} });
    expect(failed).toMatchObject({ ok: false, error: { code: 'e' } });
  });

  it('queryTask 三态：running / failed(reason) / succeeded 直返产物', async () => {
    expect(await adapterOf({ probe: { ok: true, status: 'running' } }).queryTask(channel, 'up'))
      .toEqual({ ok: true, status: 'running' });
    expect(await adapterOf({ probe: { ok: true, status: 'failed', reason: 'policy' } }).queryTask(channel, 'up'))
      .toEqual({ ok: true, status: 'failed', reason: 'policy' });
    expect(await adapterOf({ probe: { ok: true, status: 'succeeded', artifact: { url: 'https://cdn/v.mp4', width: 1280 } } }).queryTask(channel, 'up'))
      .toEqual({ ok: true, status: 'succeeded', artifact: { url: 'https://cdn/v.mp4', width: 1280 } });
  });

  it('queryTask succeeded+fileId：经 retrieveGenerationFile 补齐 url；换取失败按瞬时错误', async () => {
    const ok = adapterOf({
      probe: { ok: true, status: 'succeeded', fileId: 'f-1' },
      file: { ok: true, downloadUrl: 'https://cdn/f.mp4' },
    });
    expect(await ok.queryTask(channel, 'up')).toEqual({ ok: true, status: 'succeeded', artifact: { url: 'https://cdn/f.mp4' } });

    const broken = adapterOf({
      probe: { ok: true, status: 'succeeded', fileId: 'f-2' },
      file: { ok: false, error: { code: 'file_unavailable', message: 'later' } },
    });
    expect(await broken.queryTask(channel, 'up')).toMatchObject({ ok: false, error: { code: 'file_unavailable' } });
  });

  it('协议不支持任务查询 → task_ops_unavailable（fail 显式，不静默 running）', async () => {
    const noOps = adapterOf({ hasQuery: false });
    expect(await noOps.queryTask(channel, 'up')).toMatchObject({ ok: false, error: { code: 'task_ops_unavailable' } });
  });
});
