import { describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import type { Ai, ChannelDesc, RequestCtx } from '../../src/types.js';
import { startServer } from './helpers.js';
import { memoryDeps } from '../helpers/memory-deps.js';

/**
 * 复现测试：模型映射 externalName(对外名) → realModel(上游真实名) 时，
 * 网关/ai 包发往上游的 body.model 到底是哪个？
 *   - 客户端发出 request.model = externalName
 *   - 路由解析后 ctx.model = realModel（chat-completions.ts:264）
 *   - 两者通过 ai.chat({ request, ctx }) 分开传入
 * 本测试断言：上游收到的 model 字段 = ctx.model(realModel)，即"对外名→真实名"的重写生效。
 * 若失败，则证明 model 从未被重写，上游收到的是客户端原始 externalName。
 */

function makeAi(): Ai {
  return createAi({
    retry: {
      maxAttempts: 1,
      baseDelayMs: 5,
      maxDelayMs: 10,
      jitterRatio: 0,
      deadlineMs: 5000,
      emptyCompletionRetries: 0,
    },
    breaker: { windowMs: 60_000, failureThreshold: 99, cooldownMs: 300_000, halfOpenProbe: true },
    stream: { heartbeatIdleMs: 1000, inactivityTimeoutMs: 5000 },
    timeout: { connectMs: 2000, totalMs: 5000 },
    deadCredential: { failureThreshold: 99, windowMs: 3_600_000 },
    allowLocalUrl: true,
  }, memoryDeps());
}

const channel = (baseUrl: string): ChannelDesc => ({
  baseUrl,
  apiKey: 'sk-test',
  protocol: 'openai-compatible',
});

const OK_JSON = JSON.stringify({
  id: 'chatcmpl-1',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

async function captureUpstreamModel(): Promise<{
  server: Awaited<ReturnType<typeof startServer>>;
  getModel: () => string | undefined;
}> {
  let receivedModel: string | undefined;
  const server = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        receivedModel = (JSON.parse(raw) as Record<string, unknown>).model as string;
      } catch {
        receivedModel = undefined;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(OK_JSON);
    });
  });
  return { server, getModel: () => receivedModel };
}

describe('model 重写复现', () => {
  it('场景A：对外名 deepseek-v4-pro → realModel deepseek-chat（上游应收到真实名）', async () => {
    const { server, getModel } = await captureUpstreamModel();
    try {
      const result = await makeAi().chat({
        channel: channel(server.baseUrl),
        // 客户端发出的对外名
        request: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
        // 映射后的上游真实名
        ctx: {
          requestId: 'r-rewrite',
          model: 'deepseek-chat',
          providerName: 'deepseek',
        } as RequestCtx,
      });
      // eslint-disable-next-line no-console
      console.log('[场景A] 上游实际收到 model =', getModel(), '| result.status =', result.status);
      // 期望：发往上游的是 realModel
      expect(getModel()).toBe('deepseek-chat');
    } finally {
      await server.close();
    }
  });

  it('场景B（用户实际配置）：对外名=真实名=deepseek-v4-pro', async () => {
    const { server, getModel } = await captureUpstreamModel();
    try {
      await makeAi().chat({
        channel: channel(server.baseUrl),
        request: { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }] },
        ctx: {
          requestId: 'r-same',
          model: 'deepseek-v4-pro',
          providerName: 'deepseek',
        } as RequestCtx,
      });
      // eslint-disable-next-line no-console
      console.log('[场景B] 上游实际收到 model =', getModel());
      expect(getModel()).toBe('deepseek-v4-pro');
    } finally {
      await server.close();
    }
  });

  it('场景A 流式：chatStream 同样验证重写', async () => {
    const { server, getModel } = await captureUpstreamModel();
    try {
      const handle = await makeAi().chatStream({
        channel: channel(server.baseUrl),
        request: {
          model: 'deepseek-v4-pro',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        },
        ctx: {
          requestId: 'r-rewrite-stream',
          model: 'deepseek-chat',
          providerName: 'deepseek',
        } as RequestCtx,
      });
      const reader = handle.stream.getReader();
      // 读完整流，触发上游请求
      await reader.read();
      // eslint-disable-next-line no-console
      console.log('[场景A-流式] 上游实际收到 model =', getModel());
      expect(getModel()).toBe('deepseek-chat');
    } finally {
      await server.close();
    }
  });
});
