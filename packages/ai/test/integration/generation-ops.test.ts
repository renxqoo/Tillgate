import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import { defaultAiConfig } from '../../src/config.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 生成任务操作面（pipeline/generation-ops）：parse/query/retrieve 三动词全路径。
 * 经 createAi 走真实 HTTP（mock 上游 + minimax 协议适配器）。
 */
const makeAi = () => createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
const mmChannel = (baseUrl: string) => ({
  baseUrl, apiKey: 'sk-mm', protocol: 'minimax',
});

describe('生成任务操作面', () => {
  
  it('parseGenerationResponse：video 提交 → task_submitted；music 完成 → 产物；信封错误 → error', () => {
    const ai = makeAi();
    expect(ai.parseGenerationResponse?.({
      channel: mmChannel('https://x.test'),
      kind: 'video',
      body: { task_id: 'up-1', base_resp: { status_code: 0 } },
    })).toEqual({ kind: 'task_submitted', taskId: 'up-1' });

    const completed = ai.parseGenerationResponse?.({
      channel: mmChannel('https://x.test'),
      kind: 'music',
      body: { data: { audio_url: 'https://cdn/x.mp3' } },
    });
    expect(completed).toMatchObject({ kind: 'task_completed', artifact: { url: 'https://cdn/x.mp3' } });

    const errored = ai.parseGenerationResponse?.({
      channel: mmChannel('https://x.test'),
      kind: 'video',
      body: { base_resp: { status_code: 1004, status_msg: 'invalid api key' } },
    });
    expect(errored).toMatchObject({ kind: 'error', error: { code: 'invalid_api_key', deadCredential: true } });
  });

  it('parseGenerationResponse：非任务协议 → unsupported_protocol error', () => {
    const ai = makeAi();
    const out = ai.parseGenerationResponse?.({
      channel: { baseUrl: 'https://x.test', apiKey: 'k', protocol: 'openai-compatible' },
      kind: 'video',
      body: {},
    });
    expect(out).toMatchObject({ kind: 'error', error: { code: 'invalid_config' } });
  });

  it('queryGenerationTask：running/succeeded(file_id→retrieve 换 URL)/failed/HTTP 错误/网络错误', async () => {
    let queryBody: Record<string, unknown> = {};
    let fileBody: Record<string, unknown> = {};
    let failQuery = false;
    const upstream = await startServer((req, res) => {
      if (req.url?.includes('/v1/query/video_generation')) {
        if (failQuery) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(queryBody));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fileBody));
    });
    const ai = makeAi();
    const channel = mmChannel(upstream.baseUrl);
    try {
      // running
      queryBody = { status: 'Processing' };
      await expect(ai.queryGenerationTask?.({ channel, taskId: 't1' })).resolves.toMatchObject({
        ok: true, status: 'running',
      });
      // failed
      queryBody = { status: 'Fail' };
      await expect(ai.queryGenerationTask?.({ channel, taskId: 't1' })).resolves.toMatchObject({
        ok: true, status: 'failed',
      });
      // succeeded：Ai 层返回 fileId + 尺寸产物（URL 换取是 port 组合层职责——见下一用例）
      queryBody = { status: 'Success', file_id: 'f-9', video_width: 1920, video_height: 1080 };
      await expect(ai.queryGenerationTask?.({ channel, taskId: 't1' })).resolves.toMatchObject({
        ok: true, status: 'succeeded', fileId: 'f-9',
        artifact: { width: 1920, height: 1080 },
      });
      // HTTP 401 → 死凭据错误
      failQuery = true;
      await expect(ai.queryGenerationTask?.({ channel, taskId: 't1' })).resolves.toMatchObject({
        ok: false, error: { code: 'invalid_api_key', deadCredential: true },
      });
      failQuery = false;
      // 网络错误（连不上的端口）→ 归一 network error
      await expect(ai.queryGenerationTask?.({
        channel: mmChannel('http://127.0.0.1:1'), taskId: 't1',
      })).resolves.toMatchObject({ ok: false, error: { code: 'network' } });
    } finally {
      await upstream.close();
    }
  });

  it('retrieveGenerationFile：ok 换 URL；HTTP 错误归一', async () => {
    let status = 200;
    const upstream = await startServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ file: { download_url: 'https://cdn/x' } }) : '{"base_resp":{"status_code":1008}}');
    });
    const ai = makeAi();
    const channel = mmChannel(upstream.baseUrl);
    try {
      await expect(ai.retrieveGenerationFile?.({ channel, fileId: 'f1' })).resolves.toEqual({
        ok: true, downloadUrl: 'https://cdn/x',
      });
      status = 402;
      await expect(ai.retrieveGenerationFile?.({ channel, fileId: 'f1' })).resolves.toMatchObject({
        ok: false, error: { code: 'quota_exhausted' },
      });
    } finally {
      await upstream.close();
    }
  });
});


describe('port 组合层（createGenerationTaskAdapter）：fileId → 下载 URL 换取', () => {
  it('queryTask 在 succeeded 且仅有 fileId 时自动 retrieve 换 URL', async () => {
    const fileBody = { file: { download_url: 'https://cdn/port.mp4' } };
    const upstream = await startServer((req, res) => {
      if (req.url?.includes('/v1/query/video_generation')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'Success', file_id: 'f-port' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(fileBody));
    });
    const { createGenerationTaskAdapter } = await import('../../src/generation/task-adapter.js');
    const port = createGenerationTaskAdapter({
      ai: createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps()),
      decrypt: (_enc, _key) => 'sk-mm',
      encryptionKey: 'unused',
    });
    try {
      await expect(port.queryTask(
        { channelName: 'c', apiKeyEnc: 'x', baseUrlOverride: null, providerName: 'minimax',
          providerBaseUrl: upstream.baseUrl, providerProtocol: 'minimax' },
        't1',
      )).resolves.toEqual({
        ok: true, status: 'succeeded', artifact: { url: 'https://cdn/port.mp4' },
      });
    } finally {
      await upstream.close();
    }
  });
});
