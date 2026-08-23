/**
 * adapter 纯函数深支矩阵（dashscope / vertex / minimax / aws-bedrock / task-kit /
 * define-adapter / vendor-profiles / shared / azure）：
 * 全部表驱动直调纯函数（寻址/终改/翻译/计量/错误表/任务骨架），
 * 不起 http server——每个断言锁定一条厂商方言或骨架分支。
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { DashScopeAdapter } from '../src/adapters/dashscope.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import {
  AwsBedrockAdapter,
  parseEventstreamFrames,
  eventstreamToClaudeSse,
} from '../src/adapters/aws-bedrock.js';
import { createRestTaskOps } from '../src/adapters/task-kit.js';
import { defineAdapter } from '../src/registry/define-adapter.js';
import { AzureOpenAIAdapter, AZURE_API_VERSION } from '../src/adapters/azure-openai.js';
import { AnthropicAdapter } from '../src/adapters/anthropic.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { extractOpenAiUsage } from '../src/adapters/shared.js';
import {
  VENDOR_PROFILES,
  vendorProfileNames,
  resolveVendorProfile,
  mergeParamRules,
} from '../src/registry/vendor-profiles.js';
import { UpstreamError } from '../src/errors/kinds.js';
import { asRecord } from '../src/internal/util.js';

type Rec = Record<string, unknown>;
const ch = (protocol: string, apiKey = 'k', baseUrl = 'https://x.test'): Rec => ({
  baseUrl,
  apiKey,
  protocol,
});
/** fetch 注入替身（vertex token 交换的测试注入点） */
const fakeFetch = (impl: () => Promise<unknown>): typeof fetch => impl as unknown as typeof fetch;

// ─────────────────── dashscope ───────────────────

describe('dashscope：原生线格式翻译全分支', () => {
  const d = new DashScopeAdapter();
  it('translateResponseBody：choices 多层 content 提图（空串跳过）+ usage 尺寸/张数', () => {
    const r = d.translateResponseBody({
      output: {
        choices: [
          { message: { content: [{ image: 'https://cdn/a.png' }, { image: '' }, { text: 'x' }] } },
          { message: { content: 'not-array' } },
          7,
        ],
      },
      usage: { width: 1024, height: 768, image_count: 2 },
    }) as Rec;
    expect(r.object).toBe('list');
    expect(r.data).toEqual([{ url: 'https://cdn/a.png', size: '1024*768' }]);
    expect(r.usage).toMatchObject({ image_count: 2 });
  });
  it('translateResponseBody：无尺寸/无 image_count → 兜底（size 缺省、张数按 urls 计）', () => {
    const r = d.translateResponseBody({
      output: {
        choices: [{ message: { content: [{ image: 'https://a' }, { image: 'https://b' }] } }],
      },
    }) as Rec;
    expect(r.data).toEqual([{ url: 'https://a' }, { url: 'https://b' }]);
    expect(r.usage).toMatchObject({ image_count: 2 });
    const half = d.translateResponseBody({ output: { choices: [] }, usage: { width: 10 } }) as Rec;
    expect(half.data).toEqual([]);
  });
  it('finalizeRequestBody(images)：非 model/prompt/stream 参数收敛进 parameters；无参省略键；prompt 非字符串兜底', () => {
    const fin = d.finalizeRequestBody(
      { model: 'ext', prompt: 'p', size: '1024x1024', n: 2 },
      { endpoint: 'images', model: 'real', stream: false },
    ) as Rec;
    expect(fin.model).toBe('real');
    expect(fin.parameters).toEqual({ size: '1024x1024', n: 2 });
    expect(((fin.input as Rec).messages as Rec[])[0]).toEqual({
      role: 'user',
      content: [{ text: 'p' }],
    });
    const bare = d.finalizeRequestBody(
      { prompt: 7 },
      { endpoint: 'images', model: 'm', stream: true },
    ) as Rec;
    expect(bare.parameters).toBeUndefined();
    expect(((bare.input as Rec).messages as Rec[])[0]).toEqual({
      role: 'user',
      content: [{ text: '' }],
    });
  });
  it('planRequest：images 原生路径 + chat/embeddings compatible 路径（幂等键随行）', () => {
    const pi = { model: 'm', requestId: 'r-1', stream: false };
    const img = d.planRequest(ch('dashscope') as never, { ...pi, endpoint: 'images' });
    expect(img.path).toBe('/api/v1/services/aigc/multimodal-generation/generation');
    expect(img.headers).toMatchObject({ authorization: 'Bearer k', 'idempotency-key': 'r-1' });
    expect(d.planRequest(ch('dashscope') as never, { ...pi, endpoint: 'chat' }).path).toBe(
      '/compatible-mode/v1/chat/completions',
    );
  });
  it('错误表：dashscope code → kind 全枚举 + 未命中落 status 兜底', () => {
    const table: Array<[string, number, string]> = [
      ['InvalidApiKey', 401, 'invalid_api_key'],
      ['Throttling', 429, 'rate_limited'],
      ['Throttling_RateQuota', 429, 'rate_limited'],
      ['Throttling_AllocationQuota', 429, 'quota_exhausted'],
      ['ModelNotFound', 404, 'model_not_found'],
      ['InvalidParameter', 400, 'invalid_request'],
      ['InternalError', 500, 'upstream_error'],
    ];
    for (const [code, status, kind] of table) {
      expect(d.mapError(status, { code, message: 'x' }).kind, code).toBe(kind);
    }
    expect(d.mapError(400, { code: ' unheard_of ' }).kind).toBe('invalid_request'); // 表 miss → status 兜底
  });
});

// ─────────────────── vertex ───────────────────

describe('vertex：token 交换与寻址深支', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = JSON.stringify({
    client_email: 'sa@proj.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    project_id: 'proj-1',
  });

  it('signRequest 成功：Bearer token + 缓存（二次调用不再交换）', async () => {
    let exchanges = 0;
    const v = new VertexAiAdapter(
      fakeFetch(async () => {
        exchanges += 1;
        return { ok: true, json: async () => ({ access_token: 'tok-1', expires_in: 3600 }) };
      }),
    );
    const h1 = await v.signRequest({ url: new URL('https://v.test/x'), body: '{}', apiKey: sa });
    const h2 = await v.signRequest({ url: new URL('https://v.test/x'), body: '{}', apiKey: sa });
    expect(h1).toEqual({ authorization: 'Bearer tok-1' });
    expect(h2).toEqual({ authorization: 'Bearer tok-1' });
    expect(exchanges).toBe(1);
  });
  it('token 交换失败路径：非 2xx 抛英文错误；无 access_token 抛；expires_in 非数字走默认 TTL', async () => {
    const vFail = new VertexAiAdapter(fakeFetch(async () => ({ ok: false, status: 400 })));
    await expect(
      vFail.signRequest({ url: new URL('https://v/x'), body: '', apiKey: sa }),
    ).rejects.toThrow(/token exchange failed: 400/);
    const vNoTok = new VertexAiAdapter(
      fakeFetch(async () => ({ ok: true, json: async () => ({}) })),
    );
    await expect(
      vNoTok.signRequest({ url: new URL('https://v/x'), body: '', apiKey: sa }),
    ).rejects.toThrow(/no access_token/);
    let calls = 0;
    const vTtl = new VertexAiAdapter(
      fakeFetch(async () => {
        calls += 1;
        return { ok: true, json: async () => ({ access_token: `t${calls}` }) };
      }),
    );
    const h1 = await vTtl.signRequest({ url: new URL('https://v/x'), body: '', apiKey: sa });
    const h2 = await vTtl.signRequest({ url: new URL('https://v/x'), body: '', apiKey: sa });
    // 无 expires_in → 默认 TTL 3600s，同样进缓存（二次调用零交换）
    expect(calls).toBe(1);
    expect(h2).toEqual(h1);
  });
  it('apiKey 非 SA JSON → 显式英文错误；probeRequests 空（尽力而为语义）', async () => {
    const v = new VertexAiAdapter(
      fakeFetch(async () => ({ ok: true, json: async () => ({ access_token: 't' }) })),
    );
    await expect(
      v.signRequest({ url: new URL('https://v/x'), body: '', apiKey: 'not-json' }),
    ).rejects.toThrow(/not a service account JSON/);
    expect(v.probeRequests(ch('vertex-ai', sa) as never)).toEqual([]);
  });
  it('寻址：project 从 SA 提取、location 从 baseUrl host 提取；非标准 host 归 us-central1；stream 走 alt=sse', () => {
    const v = new VertexAiAdapter();
    const p = v.planRequest(
      {
        baseUrl: 'https://europe-west4-aiplatform.googleapis.com',
        apiKey: sa,
        protocol: 'vertex-ai',
      } as never,
      { endpoint: 'chat', model: 'gemini-2.5-pro', requestId: 'r', stream: false },
    );
    expect(p.path).toBe(
      '/v1/projects/proj-1/locations/europe-west4/publishers/google/models/gemini-2.5-pro:generateContent',
    );
    expect(
      v.planRequest(
        { baseUrl: 'https://other.example.com', apiKey: '{}', protocol: 'vertex-ai' } as never,
        { endpoint: 'chat', model: 'm', requestId: 'r', stream: true },
      ).path,
    ).toBe(
      '/v1/projects/default-project/locations/us-central1/publishers/google/models/m:streamGenerateContent?alt=sse',
    );
  });
  it('finalize/translate：经 gemini codec；extractUsage 原生形优先', () => {
    const v = new VertexAiAdapter();
    const fin = v.finalizeRequestBody(
      { messages: [{ role: 'user', content: 'q' }] },
      { endpoint: 'chat', model: 'm', stream: false },
    ) as Rec;
    expect(Array.isArray(fin.contents)).toBe(true);
    const translated = v.translateResponseBody({
      candidates: [{ content: { parts: [{ text: 'hi' }] } }],
    });
    expect(JSON.stringify(translated)).toContain('hi');
    expect(
      v.extractUsage({ usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }),
    ).toMatchObject({ inputTokens: 3, outputTokens: 1 });
  });
});

// ─────────────────── minimax ───────────────────

describe('minimax：终改/计量/错误信封/任务面深支', () => {
  const m = new MiniMaxAdapter();
  it('finalize：music 歌词透传；video 首尾帧 + duration 非数字归 6 + 分辨率档位表', () => {
    const music = m.finalizeRequestBody(
      { prompt: 'p', lyrics: 'la' },
      { endpoint: 'music', model: 'real', stream: false },
    ) as Rec;
    expect(music).toEqual({ model: 'real', prompt: 'p', lyrics: 'la', output_format: 'url' });
    const video = m.finalizeRequestBody(
      { prompt: 'p', image: 'https://img', last_frame_image: 'https://img2', size: '1080x1920' },
      { endpoint: 'video', model: 'real', stream: false },
    ) as Rec;
    expect(video).toMatchObject({
      first_frame_image: 'https://img',
      last_frame_image: 'https://img2',
      resolution: '1080P',
      duration: 6,
    });
    expect(
      (
        m.finalizeRequestBody(
          { prompt: 'p', size: '768x' },
          { endpoint: 'video', model: 'm', stream: false },
        ) as Rec
      ).resolution,
    ).toBe('768P');
    expect(
      (
        m.finalizeRequestBody(
          { prompt: 'p', size: '512' },
          { endpoint: 'video', model: 'm', stream: false },
        ) as Rec
      ).resolution,
    ).toBe('512P');
    expect(
      (
        m.finalizeRequestBody(
          { prompt: 'p', duration: 2 },
          { endpoint: 'video', model: 'm', stream: false },
        ) as Rec
      ).duration,
    ).toBe(4); // 下界钳制
  });
  it('extractUsage：usage 缺失/字段非数字 → 0 计量（不抛）', () => {
    expect(m.extractUsage({})).toBeNull();
    expect(m.extractUsage({ usage: { prompt_tokens: 'x', completion_tokens: 2 } })).toMatchObject({
      inputTokens: 0,
      outputTokens: 2,
      units: 0,
    });
  });
  it('mapError 信封矩阵：429/2049/1002/1008/未知码 + 无 status_msg 兜底文案', () => {
    const table: Array<[number, string]> = [
      [429, 'rate_limited'],
      [2049, 'invalid_api_key'],
      [1002, 'invalid_request'],
      [1026, 'invalid_request'],
      [2013, 'invalid_request'],
      [1008, 'quota_exhausted'],
      [5001, 'upstream_error'],
    ];
    for (const [code, kind] of table) {
      expect(m.mapError(200, { base_resp: { status_code: code } }).kind, String(code)).toBe(kind);
    }
    const noMsg = m.mapError(200, { base_resp: { status_code: 5001 } });
    expect(noMsg.message).toBe('minimax api error 5001');
    expect(m.mapError(200, { base_resp: { status_code: 0 } }).kind).toBe('invalid_request'); // 0 = 无错误 → 200 兜底
    expect(m.mapError(500, {})).toMatchObject({ kind: 'upstream_error' });
  });
  it('任务面：Fail → failed(reason)；Success 尺寸/文件号；file 取回；信封错误优先', () => {
    const failed = m.tasks.parseTaskStatus({ status: 'Fail' });
    expect(failed).toMatchObject({ ok: true, status: 'failed', reason: 'upstream task failed' });
    const ok = m.tasks.parseTaskStatus({
      status: 'Success',
      file_id: 'f1',
      video_width: 1080.4,
      video_height: 1920,
    });
    expect(ok).toMatchObject({
      ok: true,
      status: 'succeeded',
      fileId: 'f1',
      artifact: { width: 1080, height: 1920 },
    });
    const file = m.tasks.parseFileRetrieve({ file: { download_url: 'https://d/file' } });
    expect(file).toMatchObject({ ok: true, downloadUrl: 'https://d/file' });
    expect(m.tasks.parseFileRetrieve({}).ok).toBe(false); // 缺 download_url → invalidBody
    expect(m.tasks.parseFileRetrieve({ base_resp: { status_code: 1008 } }).ok).toBe(false); // 信封优先
    expect(m.tasks.parseTaskStatus({ base_resp: { status_code: 1004 } }).ok).toBe(false);
    const q = m.tasks.planTaskQuery(ch('minimax') as never, 'tid 1');
    expect(q.path).toBe('/v1/query/video_generation?task_id=tid%201');
    expect(q.headers).toMatchObject({ authorization: 'Bearer k' });
    expect(m.tasks.planFileRetrieve(ch('minimax') as never, 'f 1').path).toBe(
      '/v1/files/retrieve?file_id=f%201',
    );
  });
  it('parseResponse：music 完成缺 artifact → invalid_response', () => {
    const r = m.tasks.parseResponse('music', { data: {} });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error.kind).toBe('invalid_response');
    expect(m.tasks.parseResponse('music', 7).kind).toBe('error'); // 非对象体
  });
});

// ─────────────────── aws-bedrock ───────────────────

describe('aws-bedrock：事件流解析与错误表深支', () => {
  const b = new AwsBedrockAdapter();
  it('mapError 错误表：error.type → kind 全枚举（含 throttling 小写别名）；表 miss 落 status 兜底', () => {
    const table: Array<[string, number, string]> = [
      ['ThrottlingException', 400, 'rate_limited'],
      ['throttling', 400, 'rate_limited'],
      ['AccessDeniedException', 403, 'insufficient_permissions'],
      ['ValidationException', 400, 'invalid_request'],
      ['ModelStreamErrorException', 500, 'upstream_error'],
      ['InternalServerException', 500, 'upstream_error'],
      ['ModelNotReadyException', 529, 'overloaded'],
      ['ServiceUnavailableException', 503, 'overloaded'],
    ];
    for (const [type, status, kind] of table) {
      expect(b.mapError(status, { error: { type } }).kind, type).toBe(kind);
    }
    expect(b.mapError(400, { __type: 'ValidationException' }).kind).toBe('invalid_request'); // __type 不在提取面 → status 兜底
    expect(b.mapError(429, {}).kind).toBe('rate_limited');
  });
  it('translateResponseBody：claude 非流式响应 → 规范形（此前零覆盖）', () => {
    const r = b.translateResponseBody({
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 2, output_tokens: 1 },
    }) as Rec;
    expect(JSON.stringify(r)).toContain('"content":"hi"');
    expect(r.usage).toMatchObject({ prompt_tokens: 2, completion_tokens: 1 });
  });
  it('parseEventstreamFrames：数值类型头按宽度跳过（type 8 short，2 字节）不破坏后续解析', () => {
    // 手工构帧：header 名 ':n'，值类型 8（short，2 字节）——数值头只跳宽度不入表
    const name = Buffer.from(':n');
    const headers = Buffer.concat([
      Buffer.from([name.length]),
      name,
      Buffer.from([8]),
      (() => {
        const x = Buffer.alloc(2);
        x.writeUInt16BE(7);
        return x;
      })(),
    ]);
    const payload = Buffer.from('{"x":1}');
    const total = 12 + headers.length + payload.length + 4;
    const buf = Buffer.alloc(total);
    buf.writeUInt32BE(total, 0);
    buf.writeUInt32BE(headers.length, 4);
    headers.copy(buf, 12);
    payload.copy(buf, 12 + headers.length);
    const { frames, rest } = parseEventstreamFrames(buf);
    expect(frames.length).toBe(1);
    expect(frames[0]?.headers[':n']).toBeUndefined(); // 数值头跳过不入表（仅 type 7 字符串头入表）
    expect(frames[0]?.payload.toString('utf8')).toBe('{"x":1}');
    expect(rest.length).toBe(0);
  });
  it('eventstreamToClaudeSse：readable 取消传播到上游 reader', async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('x'));
      },
      cancel() {
        upstreamCancelled = true;
      },
    });
    const out = eventstreamToClaudeSse(upstream);
    await out.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(upstreamCancelled).toBe(true);
  });
});

// ─────────────────── task-kit ───────────────────

describe('task-kit：通用骨架全分支（自定义 auth + 三态 + 兜底）', () => {
  const ops = createRestTaskOps({
    paths: { submit: '/sub', query: (id) => `/q/${id}`, file: (f) => `/f/${f}` },
    auth: (channel) => ({ 'x-token': channel.apiKey }),
    envelopeError: (body) =>
      asRecord(body)?.err
        ? new UpstreamError({ kind: 'upstream_error', message: 'envelope' })
        : null,
    invalidBodyError: () =>
      new UpstreamError({ kind: 'invalid_response', message: 'invalid body' }),
    extractSubmissionTaskId: (body) =>
      typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : undefined,
    extractCompletedArtifact: (body) =>
      typeof body.url === 'string' && body.url !== '' ? { url: body.url } : undefined,
    readStatus: (body) =>
      body.status === 'ok'
        ? { status: 'succeeded', artifact: { url: 'u' } }
        : body.status === 'bad'
          ? { status: 'failed' }
          : { status: 'running' },
    extractFileUrl: (body) => (typeof body.dl === 'string' && body.dl !== '' ? body.dl : undefined),
  });
  it('parseResponse：video 提交（空串 taskId 拒）/music 完成/信封优先/非对象体', () => {
    expect(ops.parseResponse('video', { task_id: 't' })).toMatchObject({
      kind: 'task_submitted',
      taskId: 't',
    });
    expect(ops.parseResponse('video', { task_id: '' }).kind).toBe('error');
    expect(ops.parseResponse('music', { url: 'https://a' })).toMatchObject({
      kind: 'task_completed',
      artifact: { url: 'https://a' },
    });
    expect(ops.parseResponse('music', { err: 1 }).kind).toBe('error');
    expect(ops.parseResponse('music', 7).kind).toBe('error');
  });
  it('parseTaskStatus：三态 + 信封/非对象体兜底', () => {
    expect(ops.parseTaskStatus({ status: 'ok' })).toMatchObject({ ok: true, status: 'succeeded' });
    expect(ops.parseTaskStatus({ status: 'bad' })).toMatchObject({
      ok: true,
      status: 'failed',
      reason: 'upstream task failed',
    });
    expect(ops.parseTaskStatus({ status: 'other' })).toMatchObject({ ok: true, status: 'running' });
    expect(ops.parseTaskStatus({ err: 1 }).ok).toBe(false);
    expect(ops.parseTaskStatus('x').ok).toBe(false);
  });
  it('planXxx 自定义 auth 头', () => {
    expect(ops.planTaskQuery(ch('t', 'secret') as never, 't1').headers).toEqual({
      'x-token': 'secret',
    });
    expect(ops.planFileRetrieve(ch('t', 'secret') as never, 'f1').headers).toEqual({
      'x-token': 'secret',
    });
  });
});

// ─────────────────── define-adapter / azure ───────────────────

describe('defineAdapter：能力件组合面全分支', () => {
  it('缺省件全部委托 openai-compatible 默认（pick* 路径）', () => {
    const a = defineAdapter({ protocol: 'combo-x' });
    const chn = ch('combo-x') as never;
    expect(
      a.planRequest(chn, { endpoint: 'chat', model: 'm', requestId: 'r', stream: false }).path,
    ).toBe('/v1/chat/completions');
    expect(a.probeRequests(chn)[0]?.path).toBe('/v1/models');
    const { body } = a.normalizeRequest(
      { model: 'm', messages: [], store: 1 },
      { ignore: ['store'] },
      'chat',
    );
    expect((body as Rec).store).toBeUndefined();
    const fin = a.finalizeRequestBody(
      { model: 'ext', messages: [] },
      { endpoint: 'chat', model: 'real', stream: true },
    ) as Rec;
    expect((fin.stream_options as Rec).include_usage).toBe(true);
    expect(a.extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toMatchObject({
      inputTokens: 1,
    });
    expect(a.mapError(429, { error: { code: 'rate_limit_exceeded' } }).kind).toBe('rate_limited');
    expect(a.signRequest).toBeUndefined(); // 无签名件不造键
    expect(a.translateResponseBody).toBeUndefined();
  });
  it('codec/tasks/supportedEndpoints 覆写生效（含流式翻译件）', async () => {
    const a = defineAdapter({
      protocol: 'combo-y',
      supportedEndpoints: ['chat', 'video'],
      codec: {
        translateResponseBody: (b) => ({ wrapped: b }),
        translateUpstreamStream: (s) => s,
      },
      tasks: createRestTaskOps({
        paths: { submit: '/s', query: () => '/q', file: () => '/f' },
        envelopeError: () => null,
        invalidBodyError: () => new UpstreamError({ kind: 'invalid_response' }),
        extractSubmissionTaskId: () => 't',
        extractCompletedArtifact: () => ({ url: 'u' }),
        readStatus: () => ({ status: 'running' }),
        extractFileUrl: () => 'dl',
      }),
    });
    expect(a.supportedEndpoints).toEqual(['chat', 'video']);
    expect(a.translateResponseBody?.({ z: 1 })).toEqual({ wrapped: { z: 1 } });
    const src = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: x\n\n'));
        c.close();
      },
    });
    expect(await new Response(a.translateUpstreamStream!(src, 'm')).text()).toContain('data: x');
    expect(a.tasks?.parseResponse('video', {})).toMatchObject({
      kind: 'task_submitted',
      taskId: 't',
    });
  });
});

describe('azure / anthropic / gemini / shared：剩余分支', () => {
  it('azure：embeddings 部署路径 + api-key 头', () => {
    const p = AzureOpenAIAdapter.planRequest(ch('azure-openai') as never, {
      endpoint: 'embeddings',
      model: 'dep-1',
      requestId: 'r',
      stream: false,
    });
    expect(p.path).toBe(`/openai/deployments/dep-1/embeddings?api-version=${AZURE_API_VERSION}`);
    expect(p.headers).toMatchObject({ 'api-key': 'k' });
  });
  it('anthropic：finalize 双态（stream 注入/不注入）+ probe 头', () => {
    const a = new AnthropicAdapter();
    expect(
      (
        a.finalizeRequestBody(
          { model: 'm', messages: [] },
          { endpoint: 'chat', model: 'm', stream: false },
        ) as Rec
      ).stream,
    ).toBeUndefined();
    expect(a.probeRequests(ch('anthropic') as never)[0]?.headers).toMatchObject({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
    });
  });
  it('anthropic mapError：permission_error / not_found_error / invalid_request_error', () => {
    const a = new AnthropicAdapter();
    expect(a.mapError(403, { error: { type: 'permission_error' } }).kind).toBe(
      'insufficient_permissions',
    );
    expect(a.mapError(404, { error: { type: 'not_found_error' } }).kind).toBe('model_not_found');
    expect(a.mapError(400, { error: { type: 'invalid_request_error' } }).kind).toBe(
      'invalid_request',
    );
    expect(a.mapError(529, { error: { type: 'overloaded_error' } }).kind).toBe('overloaded');
  });
  it('gemini adapter：错误表 PERMISSION_DENIED / NOT_FOUND / INVALID_ARGUMENT / UNAVAILABLE', () => {
    const g = new GeminiAdapter();
    expect(g.mapError(403, { error: { status: 'PERMISSION_DENIED' } }).kind).toBe(
      'insufficient_permissions',
    );
    expect(g.mapError(404, { error: { status: 'NOT_FOUND' } }).kind).toBe('model_not_found');
    expect(g.mapError(400, { error: { status: 'INVALID_ARGUMENT' } }).kind).toBe('invalid_request');
    expect(g.mapError(503, { error: { status: 'UNAVAILABLE' } }).kind).toBe('upstream_error');
    expect(g.probeRequests(ch('gemini') as never)[0]?.headers).toMatchObject({
      'x-goog-api-key': 'k',
    });
  });
  it('shared：extractOpenAiUsage 缺字段/缺 details → null 与 0 缓存', () => {
    expect(extractOpenAiUsage({})).toBeNull();
    expect(extractOpenAiUsage({ usage: { prompt_tokens: 1 } })).toBeNull();
    expect(extractOpenAiUsage({ usage: { prompt_tokens: 1, completion_tokens: 2 } })).toMatchObject(
      { inputTokens: 1, cachedInputTokens: 0 },
    );
    expect(
      extractOpenAiUsage({
        usage: {
          prompt_tokens: 1,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 1 },
          cache_write_tokens: 3,
        },
      }),
    ).toMatchObject({ cachedInputTokens: 1, cacheWriteTokens: 3 });
  });
});

// ─────────────────── vendor-profiles ───────────────────

describe('vendor-profiles：词表封闭与合并语义', () => {
  it('词表封闭性：names == VENDOR_PROFILES 键集；每条带依据', () => {
    expect(vendorProfileNames()).toEqual(Object.keys(VENDOR_PROFILES));
    for (const p of Object.values(VENDOR_PROFILES)) expect(p.basis.length).toBeGreaterThan(0);
  });
  it('resolveVendorProfile：空/未知 → null；命中返回模板', () => {
    expect(resolveVendorProfile(undefined)).toBeNull();
    expect(resolveVendorProfile('')).toBeNull();
    expect(resolveVendorProfile('nope')).toBeNull();
    expect(resolveVendorProfile('openai')?.params.map).toEqual({
      max_tokens: { to: 'max_completion_tokens' },
    });
  });
  it('mergeParamRules：单侧/双侧全组合 + unknown 优先级', () => {
    expect(mergeParamRules(undefined, undefined)).toEqual({});
    expect(mergeParamRules(undefined, { ignore: ['x'] })).toEqual({ ignore: ['x'] });
    expect(mergeParamRules({ ignore: ['x'] }, undefined)).toEqual({ ignore: ['x'] });
    const merged = mergeParamRules(
      { ignore: ['a'], unknown: 'passthrough' },
      { ignore: ['b'], unknown: 'drop' },
    );
    expect(merged.ignore).toEqual(['a', 'b']);
    expect(merged.unknown).toBe('drop');
    expect(mergeParamRules({ unknown: 'drop' }, {}).unknown).toBe('drop'); // 单侧 unknown 保留
    expect(mergeParamRules({}, {}).unknown).toBeUndefined(); // 两侧都无 unknown 时不造键
  });
});
