import { describe, expect, it } from 'vitest';
import { DashScopeAdapter } from '../src/adapters/dashscope.js';
import { AwsBedrockAdapter } from '../src/adapters/aws-bedrock.js';
import { MiniMaxAdapter } from '../src/adapters/minimax.js';
import { VertexAiAdapter } from '../src/adapters/vertex-ai.js';
import { createRestTaskOps } from '../src/adapters/task-kit.js';
import { chatRequestToGemini, geminiUsageToUsage } from '../src/protocol/gemini-chat.js';
import { resolveCalibration, DEFAULT_TOKEN_ESTIMATE_CALIBRATION } from '../src/usage/calibration.js';
import { defaultAiDefaults, aiDefaultsSchema } from '../src/config.js';
import { ServerDrainAbort, asServerDrainAbort } from '../src/errors/server-drain.js';
import { asRecord } from '../src/internal/util.js';
import { UpstreamError } from '../src/errors/kinds.js';

const ch = (protocol: string) => ({ baseUrl: 'https://x.test', apiKey: 'k', protocol });

describe('dashscope 全分支', () => {
  const d = new DashScopeAdapter();
  it('normalizeRequest no-op 透传 + finalize images parameters 收敛', () => {
    const { body } = d.normalizeRequest({ model: 'm', prompt: 'p', size: '1024x1024' }, {}, 'images');
    expect(body).toMatchObject({ prompt: 'p' });
    const fin = d.finalizeRequestBody(body as Record<string, unknown>, { endpoint: 'images', model: 'm', stream: false });
    expect(Object.keys(fin).length).toBeGreaterThan(0);
  });
  it('translateResponseBody：images 原生形 → OpenAI images 规范形 + 幂等兜底', () => {
    const r = d.translateResponseBody?.({ output: [{ url: 'https://cdn/a.png' }] });
    expect(JSON.stringify(r)).toContain('https://cdn/a.png');
    expect(d.translateResponseBody?.({ choices: [{}] })).toEqual({ choices: [{}] }); // 幂等
  });
  it('extractUsage：images 张数计量（usage.image_count → units）', () => {
    const u = d.extractUsage({ usage: { image_count: 2 } });
    expect(u?.units).toBe(2);
    expect(d.extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toMatchObject({ inputTokens: 1 }); // 父类兜底
  });
});

describe('bedrock 全分支', () => {
  const b = new AwsBedrockAdapter();
  it('finalize：claude 形 + anthropic_version 注入', () => {
    const fin = b.finalizeRequestBody({ model: 'm', messages: [{ role: 'user', content: 'q' }] }, { endpoint: 'chat', model: 'm', stream: false });
    expect(fin.anthropic_version).toBe('bedrock-2023-05-31');
    expect((fin.messages as Array<{ content: Array<{ type: string; text?: string }> }>)[0]?.content[0]).toMatchObject({ type: 'text', text: 'q' });
  });
  it('寻址：invoke/stream 双路径 + 探测 /models', () => {
    const pi = { endpoint: 'chat' as const, model: 'm', requestId: 'r' };
    expect(b.planRequest(ch('aws-bedrock'), { ...pi, stream: false }).path).toContain('/invoke');
    expect(b.planRequest(ch('aws-bedrock'), { ...pi, stream: true }).path).toContain('invoke-with-response-stream');
    expect(b.probeRequests(ch('aws-bedrock'))[0]?.path).toBe('/models');
  });
  it('extractUsage：claude 形', () => {
    expect(b.extractUsage({ usage: { input_tokens: 3, output_tokens: 1 } })).toMatchObject({ inputTokens: 3 });
    expect(b.extractUsage({})).toBeNull();
  });
});

describe('task-kit 通用骨架', () => {
  const ops = createRestTaskOps({
    paths: { submit: '/sub', query: (id: string) => `/q/${id}`, file: (f: string) => `/f/${f}` },
    readStatus: (b) => (b.status === 'Done' ? { status: 'succeeded' as const, fileId: 'x' } : { status: 'running' as const }),
    envelopeError: (b) => (asRecord(b)?.err ? new UpstreamError({ kind: 'upstream_error' }) : null),
    invalidBodyError: () => new UpstreamError({ kind: 'invalid_response' }),
    extractSubmissionTaskId: (b) => (typeof b.task_id === 'string' ? b.task_id : undefined),
    extractCompletedArtifact: (b) => (typeof b.url === 'string' ? { url: b.url } : undefined),
    extractFileUrl: (b) => (typeof b.download_url === 'string' ? b.download_url : undefined),
  });
  it('提交/查询/取回寻址 + 状态解析', () => {
    expect(ops.planTaskQuery(ch('t'), 'tid').path).toBe('/q/tid');
    expect(ops.planFileRetrieve(ch('t'), 'fid').path).toBe('/f/fid');
    expect(ops.parseTaskStatus({ status: 'Done' })).toMatchObject({ ok: true, status: 'succeeded' });
    expect(ops.parseTaskStatus({ status: 'Other' })).toMatchObject({ ok: true, status: 'running' });
    expect(ops.parseTaskStatus([1])).toMatchObject({ ok: true, status: 'running' }); // 垃圾体不崩
  });
});

describe('gemini 请求出站 + calibration/config/drain 细节', () => {
  it('chatRequestToGemini：contents 映射 + system 指令 + 多模态 part', () => {
    const g = chatRequestToGemini({ model: 'm', messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QQ==' } }] },
    ] });
    expect(g.systemInstruction).toBeDefined();
    const parts = ((g.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>)[0]?.parts) ?? [];
    expect(parts.some((p) => typeof p.text === 'string')).toBe(true);
    expect(parts.some((p) => (p.inlineData as Record<string, unknown>)?.mimeType === 'image/png')).toBe(true);
  });
  it('geminiUsageToUsage：cached 扣出 + thoughts 计入 + 垃圾不崩', () => {
    expect(geminiUsageToUsage({ promptTokenCount: 10, cachedContentTokenCount: 3, candidatesTokenCount: 2 })).toMatchObject({ promptTokens: 10, cachedTokens: 3, completionTokens: 2 });
    expect(geminiUsageToUsage(null)).toBeNull();
    expect(geminiUsageToUsage('x')).toBeNull();
  });
  it('calibration：三层合并（defaults → provider:model 命中）', () => {
    const c = resolveCalibration('minimax', 'MiniMax-M3');
    expect(c.weights.cjk).toBeGreaterThan(0);
    expect(resolveCalibration().weights).toEqual(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.defaults);
    expect(resolveCalibration('unknown', 'unknown').weights).toEqual(DEFAULT_TOKEN_ESTIMATE_CALIBRATION.defaults);
  });
  it('config：zod 默认值全量 + 非法输入拒绝', () => {
    const d = defaultAiDefaults();
    expect(d.retry.maxAttempts).toBe(3);
    expect(d.stream.heartbeatIdleMs).toBe(30_000);
    expect(() => aiDefaultsSchema.parse({ retry: { maxAttempts: 0 } })).toThrow();
  });
  it('server-drain：标记类判定', () => {
    const e = new ServerDrainAbort();
    expect(asServerDrainAbort(e)).toBe(e);
    expect(asServerDrainAbort(new Error('x'))).toBeNull();
  });
  it('vertex SA 解析：project 提取', () => {
    const v = new VertexAiAdapter();
    const p = v.planRequest({ baseUrl: 'https://us-central1-aiplatform.googleapis.com', apiKey: JSON.stringify({ client_email: 'a@b', private_key: 'k' }), protocol: 'vertex-ai' }, { endpoint: 'chat', model: 'm', requestId: 'r', stream: false });
    expect(p.path).toContain('/models/m:generateContent');
  });
  it('minimax parseResponse：video 提交 / music 完成 / 信封错误', () => {
    const m = new MiniMaxAdapter();
    expect(m.tasks!.parseResponse('video', { task_id: 't1' })).toMatchObject({ kind: 'task_submitted', taskId: 't1' });
    expect(m.tasks!.parseResponse('music', { data: { audio_url: 'https://a.mp3' } })).toMatchObject({ kind: 'task_completed' });
    expect(m.tasks!.parseResponse('video', { base_resp: { status_code: 1004 } })).toMatchObject({ kind: 'error' });
  });
});
