import { describe, expect, it } from 'vitest';
import { withRetry, type RetryOptions, type AttemptOutcome } from '../../src/retry/with-retry.js';
import { createUpstreamError } from '../../src/errors/classify.js';

/**
 * TDD 复现测试 —— C5：上游 POST 重试非幂等，重复生成 / 重复计费风险。
 *
 * withRetry 是通用原语；create-ai.ts 把上游 POST /v1/chat/completions 和
 * /v1/embeddings 包在 withRetry 里（create-ai.ts:217,225-227 / :352,358-360）。
 * 当上游返回 retryable 错误（网络抖动 / 超时 / 5xx / 429）时，withRetry 会重发 POST。
 *
 * 问题：上游调用没有 Idempotency-Key（无去重凭证）。供应商在首请求已处理并计费、
 * 仅响应丢失/超时的情况下，重试会触发第二次生成 → 供应商成本翻倍。
 *
 * 本测试用计数 mock fn 证明：单个 retryable 错误导致 fn（即上游 POST）被调用 ≥2 次。
 * 修复方向：发送 Idempotency-Key: <requestId> 头（让供应商侧去重）。
 */

const opts: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 10,
  jitterRatio: 0,
  deadlineMs: 5000,
  emptyCompletionRetries: 2,
};

function retryableErr() {
  // 与 classifyTransportError('network'/'timeout') 一致：retryable=true
  return createUpstreamError({ code: 'network_error', message: 'network', retryable: true, circuitTrip: true });
}

describe('C5 — POST 重试非幂等（TDD 复现，当前应 FAIL）', () => {
  it('单次 retryable 错误 → 上游 POST 被调用 ≥2 次（无 Idempotency-Key 去重 → 重复生成风险）', async () => {
    let postCalls = 0;
    const fn = async (): Promise<AttemptOutcome<string>> => {
      postCalls += 1;
      // 模拟：第 1 次上游超时（供应商可能已处理），第 2 次成功
      return postCalls < 2
        ? { ok: false, error: retryableErr() }
        : { ok: true, value: 'completion' };
    };
    const { outcome } = await withRetry(fn, opts);
    expect(outcome.ok).toBe(true);
    // 重试确实发生了：上游 POST 被调用 2 次。
    // 这本身是 withRetry 的设计；BUG 在于这 2 次 POST 没有 Idempotency-Key，
    // 供应商无法去重 → 第 1 次（已计费）+ 第 2 次（再计费）= 双倍成本。
    expect(postCalls).toBe(2); // 重试发生（证明重复 POST）

    // 关键断言（修复后才成立）：调用方应在每次 POST 带 Idempotency-Key。
    // 这里验证 create-ai.ts 的 fetchUpstream 调用是否携带该头——通过契约检查。
    // （本测试聚焦原语行为；是否带头由 create-ai 集成测试覆盖。）
  });

  it('create-ai 调用上游时应携带 Idempotency-Key 头（契约检查，当前缺失 → FAIL）', async () => {
    // 直接读源码字符串，确认 authHeaders/fetchUpstream 调用未包含幂等键。
    // 这是静态契约断言：修复后 create-ai.ts 应在某处注入 'Idempotency-Key'。
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const cwd = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(cwd, '../../src/create-ai.ts'), 'utf8');
    // 当前实现不含 Idempotency-Key → 期望（修复后）包含 → 当前 FAIL
    expect(src).toMatch(/idempotency-key|Idempotency-Key/i); // 当前 FAIL：源码无此字符串
  });
});
