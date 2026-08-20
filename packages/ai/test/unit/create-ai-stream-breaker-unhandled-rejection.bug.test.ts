import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAi } from '../../src/create-ai.js';
import { defaultAiConfig } from '../../src/config.js';
import type { Ai } from '../../src/types.js';
import type { BreakerStorage, DeadCredentialStorage } from '../../src/config.js';
import { startServer, sseFrame, wait } from '../integration/helpers.js';

/**
 * BUG 复现（高危 / 可用性 + 资损）：流式路径 `void breaker.recordSuccess()` /
 * `void credential.recordSuccess()` 在存储后端（gateway 注入的 Redis）不可用时
 * 会产生未处理的 Promise rejection，默认配置下会杀死进程。
 *
 * 背景：
 *   - gateway 把业务 Redis（enableOfflineQueue:false）注入 createAi 作为熔断/死凭据存储。
 *   - Redis 宕机/故障转移时，存储的 getState/compareAndSet 立即 reject。
 *   - create-ai.ts 流式成功路径用 `void breaker.recordSuccess()` 丢弃了 promise，
 *     没有 .catch() / await → 触发 unhandledRejection。
 *   - 非流式路径（create-ai.ts:266-267）是 await，不会崩；只有流式路径用 void。
 *   - 全仓库无 process.on('unhandledRejection') 兜底 → Node 默认 throw → 进程崩溃。
 *
 * 本测试用「恒 reject 的存储」模拟 Redis 宕机，跑一次真实流式 chatStream，
 * 断言不会有 unhandledRejection 冒泡（修复后应绿；修复前应红）。
 */

/**
 * 模拟「Redis 在请求中途宕机」：canRequest() 的 getState() 仍能返回（放行），
 * 但随后 recordSuccess() 的 getState() 已打到挂掉的 Redis → reject。
 *
 * recordSuccess 内部：`const state = await this.load()`（即 getState）。
 * load() reject → recordSuccess reject → 被 `void` 丢弃 → unhandledRejection。
 *
 * 用「首次 getState 返回 null（closed，放行），之后 getState 全 reject」精确复现
 * gateway 业务 Redis 在 canRequest 成功后、recordSuccess 前断连的窗口。
 */
function flappingBreakerStorage(): BreakerStorage {
  let reads = 0;
  return {
    getState: async () => {
      reads += 1;
      if (reads === 1) return null; // canRequest 首次探测：放行（closed）
      throw new Error('redis ECONNREFUSED (breaker storage went down mid-request)');
    },
    compareAndSet: () => Promise.reject(new Error('redis down')),
    setState: () => Promise.reject(new Error('redis down')),
  };
}

function flappingDeadCredentialStorage(): DeadCredentialStorage {
  let reads = 0;
  return {
    getState: async () => {
      reads += 1;
      if (reads === 1) return null;
      throw new Error('redis ECONNREFUSED (credential storage went down mid-request)');
    },
    compareAndSet: () => Promise.reject(new Error('redis down')),
    setState: () => Promise.reject(new Error('redis down')),
  };
}

/** 规避 canRequest 早返（存储 reject 时 canRequest 会降级放行），让执行走到 recordSuccess */
function makeAiWithRejectingStorage(): Ai {
  const cfg = { ...defaultAiConfig(), allowLocalUrl: true };
  return createAi(cfg, {
    breakerStorage: flappingBreakerStorage(),
    deadCredentialStorage: flappingDeadCredentialStorage(),
  });
}

describe('流式熔断器 void 调用：存储不可用时不应产生 unhandledRejection', () => {
  let upstream: Awaited<ReturnType<typeof startServer>>;
  let ai: Ai;

  beforeAll(async () => {
    // 本地 mock 上游：返回一段正常 SSE 流（确保走到「首帧成功 → recordSuccess」分支）
    upstream = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })));
      res.write(
        sseFrame(
          JSON.stringify({
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        ),
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    ai = makeAiWithRejectingStorage();
  });

  afterAll(async () => {
    await upstream.close();
  });

  it('chatStream 成功路径，存储 reject 被吞掉，无 unhandledRejection 冒泡', async () => {
    // 捕获 unhandledRejection：修复前会被触发（测试 FAIL）；修复后不触发（PASS）
    const rejections: unknown[] = [];
    const handler = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', handler);
    try {
      const handle = await ai.chatStream({
        channel: { baseUrl: upstream.baseUrl, apiKey: 'sk-test', protocol: 'openai-compatible' },
        request: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true },
        ctx: { requestId: 'req-bug-stream-breaker', model: 'm', providerName: 'mock', endpoint: 'chat' },
      });
      // 消费流以触发 success 事件 → recordSuccess（雷区）
      const reader = handle.stream.getReader();
      // 读若干帧后退出（不需要读完整流）
      for (let i = 0; i < 4; i++) {
        const { done } = await reader.read();
        if (done) break;
      }
      await reader.cancel().catch(() => {});
      // 给微任务/事件循环一点时间让被 void 丢弃的 promise 的 rejection 冒泡
      await wait(50);
      expect(
        rejections,
        '不应有未处理的 Promise rejection（流式 breaker void 调用需吞掉存储错误）',
      ).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
    }
  });
});
