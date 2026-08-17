import { describe, expect, it } from 'vitest';
import { MiniMaxAdapter } from '../../src/adapters/minimax.js';

/**
 * MiniMax 适配器契约（纯函数，无网络）：请求构造 / base_resp 错误信封 /
 * 任务状态映射 / 产物解析。事实源：MiniMax 开放平台 API + new-api hailuo 参照。
 */
const adapter = new MiniMaxAdapter();
const channel = { baseUrl: 'https://api.minimaxi.com', apiKey: 'sk-test', protocol: 'minimax' };

describe('minimax 适配器', () => {
  it('video 提交响应 → task_submitted', () => {
    const parsed = adapter.tasks!.parseResponse('video', {
      base_resp: { status_code: 0, status_msg: 'success' },
      task_id: 'task-123',
      status: 'Queueing',
    });
    expect(parsed).toMatchObject({ kind: 'task_submitted', taskId: 'task-123' });
  });

  it('music 响应 → task_completed（归一产物 artifact.url）', () => {
    const parsed = adapter.tasks!.parseResponse('music', {
      base_resp: { status_code: 0 },
      data: { audio: 'hex', audio_url: 'https://cdn/x.mp3', status: 2 },
    });
    expect(parsed).toMatchObject({ kind: 'task_completed', artifact: { url: 'https://cdn/x.mp3' } });
  });

  it('HTTP 200 但 base_resp 错误 → 归一错误（1004 死凭据 / 1008 余额 / 1026 内容）', () => {
    const auth = adapter.tasks!.parseResponse('video', {
      base_resp: { status_code: 1004, status_msg: 'invalid api key' },
    });
    expect(auth).toMatchObject({
      kind: 'error',
      error: { code: 'invalid_api_key', deadCredential: true },
    });

    const quota = adapter.mapError(200, { base_resp: { status_code: 1008, status_msg: 'no balance' } });
    expect(quota.code).toBe('quota_exhausted');
    expect(quota.retryable).toBe(false);

    const content = adapter.mapError(200, { base_resp: { status_code: 1026, status_msg: 'sensitive' } });
    expect(content.code).toBe('invalid_request');
  });

  it('任务状态映射：Queueing/Processing→running、Success→succeeded（带 file_id/尺寸）、Fail→failed', () => {
    const running = adapter.tasks!.parseTaskStatus({
      base_resp: { status_code: 0 },
      task_id: 't',
      status: 'Processing',
    });
    expect(running).toMatchObject({ ok: true, status: 'running' });

    const done = adapter.tasks!.parseTaskStatus({
      base_resp: { status_code: 0 },
      task_id: 't',
      status: 'Success',
      file_id: 'f-1',
      video_width: 1280,
      video_height: 720,
    });
    expect(done).toMatchObject({
      ok: true,
      status: 'succeeded',
      fileId: 'f-1',
      artifact: { width: 1280, height: 720 },
    });

    const failed = adapter.tasks!.parseTaskStatus({
      base_resp: { status_code: 0 },
      task_id: 't',
      status: 'Fail',
    });
    expect(failed).toMatchObject({ ok: true, status: 'failed' });
  });

  it('产物取回：file.download_url', () => {
    const file = adapter.tasks!.parseFileRetrieve({
      base_resp: { status_code: 0 },
      file: { file_id: 'f-1', download_url: 'https://cdn/video.mp4' },
    });
    expect(file).toMatchObject({ ok: true, downloadUrl: 'https://cdn/video.mp4' });
  });

  it('video 请求体：duration 钳制(4-15)与缺省 6、size→resolution、image→first_frame_image', () => {
    const body = adapter.finalizeRequestBody(
      { model: 'external', prompt: 'p', duration: 99, size: '1280x720', image: 'data:image/png;base64,x' },
      { endpoint: 'video', model: 'MiniMax-H3', stream: false },
    );
    expect(body).toEqual({
      model: 'MiniMax-H3',
      prompt: 'p',
      duration: 15,
      resolution: '720P',
      first_frame_image: 'data:image/png;base64,x',
    });

    const defaulted = adapter.finalizeRequestBody(
      { model: 'x', prompt: 'p' },
      { endpoint: 'video', model: 'MiniMax-H3', stream: false },
    );
    expect(defaulted).toMatchObject({ duration: 6, resolution: '720P' });
  });

  it('music 请求体：output_format=url 白名单', () => {
    const body = adapter.finalizeRequestBody(
      { model: 'x', prompt: 'jazz', lyrics: '[verse]', junk: 'dropped' },
      { endpoint: 'music', model: 'music-01', stream: false },
    );
    expect(body).toEqual({ model: 'music-01', prompt: 'jazz', lyrics: '[verse]', output_format: 'url' });
  });

  it('任务查询寻址：taskId 进 query string + Bearer', () => {
    const plan = adapter.tasks!.planTaskQuery(channel, 't&1');
    expect(plan.path).toBe('/v1/query/video_generation?task_id=t%261');
    expect(plan.headers.authorization).toBe('Bearer sk-test');
  });
});
