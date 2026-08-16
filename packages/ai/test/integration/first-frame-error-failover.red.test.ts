import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiEvent } from '../../src/events.js';
import { createAi } from '../../src/create-ai.js';
import { sseFrame, startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 红测（new-api #6643 同类）：上游以 HTTP 200 + SSE 首帧即错误（限流/配额类
 * 错误放在流体内而非状态码）时，ai 层必须发出可供网关换渠道的 failed 终态事件。
 *
 * 现状：peekFirstChunk 只检测空流（create-ai.ts:459-460），不识别「首帧即错误」；
 * 200 响应建立流后，错误帧只触发 relay-stream 的 terminated='upstream_error'，
 * done 事件仍走 success 分支（create-ai.ts:519-541）——failed 事件永远不会发出。
 * 网管 attempt-runner 仅凭 failed 事件换渠道（attempt-runner.ts:286-291），
 * 因此该场景：客户端收到上游错误原文、无渠道切换、按部分/零 usage 结算。
 *
 * 本测只证明 bug 存在，不修复（修复方向：peek 首帧识别错误帧 → failEarly）。
 */

function makeAi() {
  return createAi({
    retry: {
      maxAttempts: 1,
      baseDelayMs: 5,
      maxDelayMs: 10,
      jitterRatio: 0,
      deadlineMs: 5000,
      emptyCompletionRetries: 0,
    },
    breaker: { windowMs: 60_000, failureThreshold: 100, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
    timeout: { connectMs: 2000, totalMs: 5000 },
    allowLocalUrl: true,
  }, memoryDeps());
}

describe('ai.chatStream：200 + 首帧即错误（#6643 同类红测）', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    // 上游返回 200，但第一个（也是唯一的）数据帧是错误对象——OpenAI 兼容生态中
    // 部分供应商/二层代理用这种形状报告限流，而不是 HTTP 429。
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        sseFrame(
          JSON.stringify({
            error: {
              code: 'rate_limit_exceeded',
              type: 'rate_limit_error',
              message: 'Concurrent request limit reached',
            },
          }),
        ),
      );
      res.write(sseFrame('[DONE]'));
      res.end();
    });
  });
  afterAll(async () => {
    await server.close();
  });

  it('首帧即错误 → 必须发出 failed 事件（网关据此换渠道）', async () => {
    const ai = makeAi();
    const events: AiEvent[] = [];
    ai.onEvent((e) => events.push(e));

    const handle = await ai.chatStream({
      channel: { baseUrl: server.baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible' },
      request: { model: 'test-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      ctx: { requestId: 'ff-err-1', model: 'test-model', providerName: 'test' },
    });

    // 消费完返回的流（错误帧会被透传给客户端）
    const reader = handle.stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    // 等待终态事件到达（流结束后事件是异步派发的）
    await new Promise((r) => setTimeout(r, 100));

    const failed = events.find((e) => e.type === 'failed');
    // 期望存在 failed（可换渠道的失败信号）。现状：只有 success(terminated) → 红。
    expect(failed).toBeDefined();
  });

  it('非流式：200 + 错误体 JSON → 必须归类为失败（而非成功+估算 usage）', async () => {
    const bodyServer = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'insufficient_quota', type: 'insufficient_quota', message: 'You exceeded your quota' },
        }),
      );
    });
    try {
      const ai = makeAi();
      const result = await ai.chat({
        channel: { baseUrl: bodyServer.baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible' },
        request: { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] },
        ctx: { requestId: 'ff-err-2', model: 'test-model', providerName: 'test' },
      });
      // 期望：失败分支（quota_exhausted 语义）。现状：success + 估算 usage → 红。
      expect(result.status).not.toBe('success');
    } finally {
      await bodyServer.close();
    }
  });
});
