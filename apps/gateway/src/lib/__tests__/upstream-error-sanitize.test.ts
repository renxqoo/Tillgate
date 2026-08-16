import { describe, expect, it } from 'vitest';
import { sanitizeUpstreamDetail } from '../upstream-error-sanitize.js';
import { rewriteSseModel } from '../sse-model-rewrite.js';
import { ReadableStream } from 'node:stream/web';

/**
 * 上游错误出站脱敏（api-contract 白标承诺）：
 * 真实模型名 / 供应商标识 / URL / HTML / 超长文案不得到达终端用户。
 * FINDINGS-2 静态项「上游错误信息透传」的回归测试。
 */

const ctx = {
  realModels: ['nvidia/nemotron-70b:free'],
  externalModel: 'gpt-x',
  providerNames: ['SiliconCloud'],
};

describe('sanitizeUpstreamDetail', () => {
  it('真实模型名 → 对外名；供应商 → 上游服务', () => {
    const raw = 'model nvidia/nemotron-70b:free does not exist (SiliconCloud)';
    expect(sanitizeUpstreamDetail(raw, ctx)).toBe('model gpt-x does not exist (上游服务)');
  });
  it('URL 剥除 + HTML 粗剥 + 300 字封顶', () => {
    const raw = `see https://api.internal.vendor.local/v1/docs <b>502</b> Bad Gateway ${'x'.repeat(400)}`;
    const out = sanitizeUpstreamDetail(raw, ctx);
    expect(out).not.toContain('http');
    expect(out).not.toContain('<b>');
    expect(out.length).toBeLessThanOrEqual(302);
    expect(out.endsWith('…')).toBe(true);
  });
  it('空值兜底「上游服务错误」', () => {
    expect(sanitizeUpstreamDetail(undefined, ctx)).toBe('上游服务错误');
    expect(sanitizeUpstreamDetail('   ', ctx)).toBe('上游服务错误');
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += new TextDecoder().decode(chunk);
  return out;
}

describe('rewriteSseModel 错误帧脱敏', () => {
  it('error 帧 message 中真实模型名/URL 被替换，正常帧不受影响', async () => {
    const frames = [
      'data: {"id":"1","object":"chat.completion.chunk","model":"nvidia/nemotron-70b:free","choices":[]}',
      'data: {"error":{"message":"nvidia/nemotron-70b:free quota exceeded, see https://scloud.internal/help","type":"upstream"}}',
      'data: [DONE]',
    ].join('\n');
    const out = await collect(
      rewriteSseModel(
        ReadableStream.from([new TextEncoder().encode(frames)]),
        'gpt-x',
        (frame) => {
          const e = frame.error as { message?: unknown } | undefined;
          if (e && typeof e.message === 'string') {
            e.message = sanitizeUpstreamDetail(e.message, ctx);
          }
          return frame;
        },
      ),
    );
    expect(out).toContain('"model":"gpt-x"');
    expect(out).not.toContain('nvidia');
    expect(out).not.toContain('https://');
    expect(out).toContain('[DONE]');
  });
  it('未传 sanitize 回调时保持既有行为（只改 model 字段）', async () => {
    const frames = 'data: {"model":"nvidia/nemotron-70b:free","error":{"message":"nvidia/nemotron-70b:free died"}}';
    const out = await collect(
      rewriteSseModel(ReadableStream.from([new TextEncoder().encode(frames)]), 'gpt-x'),
    );
    expect(out).toContain('"model":"gpt-x"');
    // 无脱敏回调时错误文案原样（向后兼容；生产管线始终传回调）
    expect(out).toContain('died');
  });
});
