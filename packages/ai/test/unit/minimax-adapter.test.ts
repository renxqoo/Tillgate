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

describe('MiniMax base_resp 信封全码位 + 分辨率映射', () => {
  const mmAdapter = new MiniMaxAdapter();

  it('429 → rate_limited；1002/2013 → invalid_request；未知码 → upstream_error(502 跳闸)', () => {
    expect(mmAdapter.mapError(200, { base_resp: { status_code: 429, status_msg: 'too fast' } }).code).toBe('rate_limited');
    expect(mmAdapter.mapError(200, { base_resp: { status_code: 1002, status_msg: 'params' } }).code).toBe('invalid_request');
    expect(mmAdapter.mapError(200, { base_resp: { status_code: 2013, status_msg: 'n/a' } }).code).toBe('invalid_request');
    const unknown = mmAdapter.mapError(200, { base_resp: { status_code: 9999, status_msg: 'weird' } });
    expect(unknown.code).toBe('upstream_error');
    expect(unknown.retryable).toBe(true);
    expect(unknown.circuitTrip).toBe(true);
    expect(unknown.status).toBe(502);
    // status_code=0 或无信封 → 非错误（null）
    expect(mmAdapter.mapError(200, { base_resp: { status_code: 0 } }).code).not.toBe('upstream_error');
  });

  it('chat 寻址/终改：/v1/chat/completions + model 重写透传；embeddings 寻址', () => {
    const ch = { baseUrl: 'https://api.minimax.chat', apiKey: 'k', protocol: 'minimax' };
    expect(mmAdapter.planRequest(ch, { endpoint: 'chat', model: 'm', requestId: 'r', stream: false }).path).toBe('/v1/chat/completions');
    expect(mmAdapter.planRequest(ch, { endpoint: 'embeddings', model: 'm', requestId: 'r', stream: false }).path).toBe('/v1/embeddings');
    const final = mmAdapter.finalizeRequestBody({ model: 'ext', messages: [], max_tokens: 5 }, { endpoint: 'chat', model: 'MiniMax-M3', stream: false });
    expect(final).toEqual({ model: 'MiniMax-M3', messages: [], max_tokens: 5 });
  });

  it('video 终改：duration 钳制（4-15）、size→resolution 档位、帧图字段映射', () => {
    const base = { model: 'video-01', prompt: 'p' };
    expect(mmAdapter.finalizeRequestBody({ ...base, duration: 99, size: '1024x1080' }, { endpoint: 'video', model: 'm', stream: false }))
      .toMatchObject({ duration: 15, resolution: '1080P' });
    expect(mmAdapter.finalizeRequestBody({ ...base, size: '768x768' }, { endpoint: 'video', model: 'm', stream: false }))
      .toMatchObject({ duration: 6, resolution: '768P' });
    expect(mmAdapter.finalizeRequestBody({ ...base, size: '512x512' }, { endpoint: 'video', model: 'm', stream: false }))
      .toMatchObject({ resolution: '512P' });
    // 无法识别的 size → 默认 720P；帧图映射
    const withFrames = mmAdapter.finalizeRequestBody(
      { ...base, size: 'weird', image: 'https://a.png', last_frame_image: 'https://b.png' },
      { endpoint: 'video', model: 'm', stream: false },
    );
    expect(withFrames).toMatchObject({ resolution: '720P', first_frame_image: 'https://a.png', last_frame_image: 'https://b.png' });
    // duration 过小 → 钳到 4
    expect(mmAdapter.finalizeRequestBody({ ...base, duration: 1 }, { endpoint: 'video', model: 'm', stream: false }))
      .toMatchObject({ duration: 4 });
  });

  it('music 终改：白名单重建 + output_format=url；usage 提取（0/负值归 0）', () => {
    expect(mmAdapter.finalizeRequestBody({ model: 'm', prompt: 'p', lyrics: 'l', extra: 'x' }, { endpoint: 'music', model: 'm2', stream: false }))
      .toEqual({ model: 'm2', prompt: 'p', lyrics: 'l', output_format: 'url' });
    expect(mmAdapter.extractUsage({ usage: { prompt_tokens: 3, completion_tokens: -1 } }))
      .toMatchObject({ inputTokens: 3, outputTokens: 0 });
    expect(mmAdapter.extractUsage({})).toBeNull();
  });

  it('任务操作面：planTaskQuery/planFileRetrieve 寻址编码', () => {
    const ch = { baseUrl: 'https://api.minimax.chat', apiKey: 'k', protocol: 'minimax' };
    expect(mmAdapter.tasks!.planTaskQuery(ch, 'task/1').path).toContain(encodeURIComponent('task/1'));
    expect(mmAdapter.tasks!.planFileRetrieve!(ch, 'f 2').path).toContain(encodeURIComponent('f 2'));
  });
});
