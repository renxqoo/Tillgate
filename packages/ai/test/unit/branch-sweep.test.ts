import { describe, expect, it } from 'vitest';
import { AnthropicAdapter } from '../../src/adapters/anthropic.js';
import { parseAwsCredentials, signBedrockRequest } from '../../src/adapters/aws-bedrock.js';
import { openaiErrorFrame } from '../../src/protocol/stream-convert.js';
import { estimateInputTokens, estimateOutputTokens, estimateUsage } from '../../src/usage/token-estimate.js';
import { makeParseGenerationResponse, makeQueryGenerationTask, makeRetrieveGenerationFile } from '../../src/pipeline/generation-ops.js';
import { defineAdapter } from '../../src/registry/define-adapter.js';
import { defaultAiConfig } from '../../src/config.js';
import { GeminiAdapter } from '../../src/adapters/gemini.js';
import { createAi } from '../../src/create-ai.js';
import { startServer } from '../integration/helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/** 分支扫尾：anthropic 错误家谱 / AWS 凭据 / 估算器形态 / generation-ops 缺操作面 */
describe('anthropic mapError 家谱（error.type 归一）', () => {
  const adapter = new AnthropicAdapter();
  it.each([
    ['authentication_error', 'invalid_api_key', true],
    ['permission_error', 'forbidden', undefined],
    ['not_found_error', 'model_not_found', undefined],
    ['rate_limit_error', 'rate_limited', undefined],
    ['overloaded_error', 'upstream_overloaded', undefined],
  ] as const)('error.type=%s → %s', (type, code, dead) => {
    const err = adapter.mapError(400, { type: 'error', error: { type, message: 'x' } });
    expect(err.code).toBe(code);
    if (dead !== undefined) expect(err.deadCredential).toBe(dead);
  });
  it('error 非对象（字符串）→ 走通用分类', () => {
    expect(adapter.mapError(429, { error: 'rate limited' }).code).toBe('rate_limited');
    expect(adapter.mapError(404, {}).code).toBe('model_not_found');
  });
  it('normalizeRequest 透传 + translate 委托', async () => {
    expect(adapter.normalizeRequest({ a: 1 }, {})).toEqual({ body: { a: 1 }, adjustments: [] });
    expect(adapter.translateResponseBody({ content: [{ type: 'text', text: 'hi' }], usage: null })).toBeDefined();
    await expect(new Response(adapter.translateUpstreamStream(new ReadableStream<Uint8Array>({ start: (c) => c.close() }))).text())
      .resolves.toContain('[DONE]');
  });
});

describe('AWS 凭据与签名边角', () => {
  it('parseAwsCredentials：两段/三段/坏形状', () => {
    expect(parseAwsCredentials('ak:sk')).toEqual({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: undefined });
    expect(parseAwsCredentials('ak:sk:tok')).toEqual({ accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'tok' });
    expect(parseAwsCredentials('only')).toBeNull();
    expect(parseAwsCredentials(':')).toBeNull();
  });
  it('signBedrockRequest：GET 空体签名可生成（authorization 四段）', () => {
    const headers = signBedrockRequest({
      method: 'GET',
      url: new URL('https://bedrock.us-east-1.amazonaws.com/models'),
      body: '',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      amzDate: new Date(Date.UTC(2026, 0, 1)),
    });
    expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256/);
    expect(headers['x-amz-date']).toBeDefined();
  });
});

describe('token 估算器形态矩阵', () => {
  it('estimateInputTokens：input 数组（字符串/数字/嵌套）+ prompt/query 顶层', () => {
    const n = estimateInputTokens({ input: ['abc', 7, [1, 2]], prompt: 'hello', query: 'q' });
    expect(n).toBeGreaterThan(0);
  });
  it('estimateOutputTokens：content 块数组 / reasoning_content / tool_calls 分量 / 补全 text', () => {
    const message = estimateOutputTokens({
      choices: [{ message: { content: [{ type: 'text', text: '块文本' }] } }],
    });
    expect(message).toBeGreaterThan(0);
    const reasoning = estimateOutputTokens({
      choices: [{ message: { content: '', reasoning_content: '思考内容' } }],
    });
    expect(reasoning).toBeGreaterThan(0);
    const tools = estimateOutputTokens({
      choices: [{ message: { content: '', tool_calls: [{ function: { name: 'fn', arguments: '{"a":1}' } }] } }],
    });
    expect(tools).toBeGreaterThan(0);
    const completion = estimateOutputTokens({ choices: [{ text: 'legacy text' }] });
    expect(completion).toBeGreaterThan(0);
    expect(estimateOutputTokens('junk')).toBe(0);
  });
  it('estimateUsage：非对象兜底 0', () => {
    expect(estimateUsage('junk', 'junk2', {})).toMatchObject({ estimated: true });
  });
});

describe('generation-ops 缺操作面分支', () => {
  const deps = { cfg: defaultAiConfig(), resolveAdapter: undefined as never, supportedProtocols: ['no-tasks'] };
  it('tasks 适配器缺失 file 面 → unsupported；query 同', async () => {
    const noFile = defineAdapter({
      protocol: 'no-tasks',
      addressing: { planRequest: () => ({ path: '/x', headers: {} }) },
    });
    // 伪造带 tasks 但无 file 的适配器（直接构造对象——测试专用形状）
    const partial = {
      ...noFile,
      tasks: {
        parseResponse: () => ({ kind: 'error' as const, error: new Error('x') as never }),
        planTaskQuery: () => ({ path: '/q', headers: {} }),
        parseTaskStatus: () => ({ ok: true as const, status: 'running' as const }),
      },
    };
    const d = { ...deps, resolveAdapter: () => partial as never };
    const retrieve = makeRetrieveGenerationFile(d);
    const out = await retrieve({ channel: { baseUrl: 'https://x', apiKey: 'k', protocol: 'no-tasks' }, fileId: 'f' });
    expect(out).toMatchObject({ ok: false, error: { code: 'invalid_config' } });
    const parse = makeParseGenerationResponse(d);
    expect(parse({ channel: { baseUrl: 'https://x', apiKey: 'k', protocol: 'no-tasks' }, kind: 'video', body: {} }))
      .toMatchObject({ kind: 'error' });
    const query = makeQueryGenerationTask(d);
    await expect(query({ channel: { baseUrl: 'https://x', apiKey: 'k', protocol: 'no-tasks' }, taskId: 't' }))
      .resolves.toMatchObject({ ok: false });
  });
});

describe('chat 非对象请求体 + FormData 直传分支', () => {
  it('request 为非对象字符串：透传序列化（asRecord null 分支）', { timeout: 30_000 }, async () => {
    const upstream = await startServer((_q, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'a', content: 'ok' } }] }));
    });
    try {
      const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
      const result = await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: 'plain-string-body',
        ctx: { requestId: 'raw-body', model: 'm', providerName: 't', endpoint: 'chat', maxRetries: 0 },
      });
      expect(result.status).toBe('success');
    } finally {
      await upstream.close();
    }
  });

  it('FormData 请求体：直传（无 content-type 头注入）', async () => {
    let sawContentType: string | undefined;
    let sawBody: string;
    const upstream = await startServer((req, res) => {
      sawContentType = req.headers['content-type'];
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        sawBody = raw;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: 'transcribed' }));
      });
    });
    try {
      const ai = createAi({ ...defaultAiConfig(), allowLocalUrl: true }, memoryDeps());
      const form = new FormData();
      form.append('model', 'whisper-external'); // 对外名——应被重写为真实名
      form.append('file', new File([new Uint8Array([1, 2, 3])], 'a.mp3', { type: 'audio/mpeg' }));
      const result = await ai.chat({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'k', protocol: 'openai-compatible' },
        request: { model: 'whisper-external', audioSeconds: 2, upstreamForm: form },
        ctx: { requestId: 'form-body', model: 'whisper-real', providerName: 't', endpoint: 'audio_transcription', maxRetries: 0 },
      });
      expect(result.status).toBe('success');
      expect(sawContentType).toContain('multipart/form-data; boundary=');
      expect(sawBody!).toContain('name="file"');
      expect(sawBody!).toContain('whisper-real'); // model 重写进表单
    } finally {
      await upstream.close();
    }
  });
});

describe('stream-convert 边角', () => {
  it('openaiErrorFrame：缺 type/detail 的部分帧', () => {
    const raw = new TextDecoder().decode(openaiErrorFrame({ code: 'e1' }));
    const frame = JSON.parse(raw.replace(/^data: /, '').trim());
    expect(frame.error).toEqual({ code: 'e1', type: undefined, message: undefined });
  });
  it('gemini 适配器 mapError：403 → invalid_api_key 非死凭据', () => {
    const err = new GeminiAdapter().mapError(403, {});
    expect(err.code).toBe('invalid_api_key');
    expect(err.deadCredential).toBe(false);
  });
});
