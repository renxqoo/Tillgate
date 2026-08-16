import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { inferenceEndpoints, inferenceRoutes } from '../inference-endpoints.js';
import type { LlmPipeline } from '../../services/pipeline/llm-pipeline.js';

/**
 * 红测（new-api #2463 / #2443 同类）：embeddings input 校验过窄，拒绝
 * OpenAI 官方与多模态生态的合法形态。
 *
 * 现状（inference-endpoints.ts:40）：input 只接受 string | string[]——
 *   1. OpenAI 官方规范的 token 数组 `number[]`（与 `number[][]`）被 400；
 *   2. 多模态 embedding（豆包/千问 VL 等开放生态）的结构化数组
 *      `[{type:'text',...},{type:'image_url',...}]` 被 400。
 * 我们对未知「参数」是 passthrough 哲学，对 input 的结构化形态却硬拒——
 * 与自身透传原则不一致，且直接断送多模态 embedding 供应商接入。
 *
 * 本测只证明 bug 存在，不修复（修复方向：input 放宽为
 * string | number[] | Array<string | number[] | unknown>，仅保留数量/体积上界）。
 */

function makeEmbeddingsApp(): Hono {
  const endpoint = inferenceEndpoints.find((e) => e.kind === 'embeddings')!;
  const stubPipeline = {
    run: async () => new Response(JSON.stringify({ data: [], model: 'x', usage: {} }), { status: 200 }),
  } as unknown as LlmPipeline;
  return new Hono().route('/', inferenceRoutes(stubPipeline, endpoint));
}

describe('embeddings input 形态（#2463 同类红测）', () => {
  it('OpenAI 官方 token 数组 input 不应被校验拒绝', async () => {
    const app = makeEmbeddingsApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'emb', input: [1, 2, 3, 4] }),
    });
    expect(res.status).toBe(200);
  });

  it('多模态结构化 input（豆包/千问 VL 形态）不应被校验拒绝', async () => {
    const app = makeEmbeddingsApp();
    const res = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'emb-vl',
        input: [{ type: 'text', text: '描述这张图' }, { type: 'image_url', image_url: { url: 'https://x/img.png' } }],
      }),
    });
    expect(res.status).toBe(200);
  });
});
