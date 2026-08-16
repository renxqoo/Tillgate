import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { RateLimiter } from '../rate-limit-service.js';

/**
 * 红测（new-api #6412 / #2841 同类）：Lua 脚本 evalsha 无 NOSCRIPT 回退。
 *
 * 场景：Redis 重启 / 故障转移 / SCRIPT FLUSH 后，已 LOAD 的脚本消失，
 * evalsha 抛 NOSCRIPT。Redis 官方恢复模式：收到 NOSCRIPT → 重新 LOAD/EVAL
 * 重跑。当前实现把 sha 缓存在实例字段且永不重载（rate-limit-service.ts 4 个
 * 脚本 + infrastructure/ai-storage.ts 熔断 CAS 同病）——Redis 恢复健康后
 * NOSCRIPT 依旧持续；checkAll 在管线（llm-pipeline.ts:133）无 try/catch，
 * 异常直达 appErrorHandler → 全量推理请求 500，直到网关进程重启。
 *
 * 注：真实 Redis 中 sha 是脚本体的确定性哈希——FLUSH 后重新 LOAD 返回同一
 * sha，故「重载后重试 evalsha」即可自愈（mock 按此语义建模）。
 * 本测只证明 bug 存在，不修复。
 */

class RestartingRedis {
  private loaded: string | null = null;

  /** 模拟 SCRIPT FLUSH / Redis 重启：脚本缓存清空 */
  flush(): void {
    this.loaded = null;
  }

  async script(_cmd: string, body: string): Promise<string> {
    this.loaded = body;
    return `sha:${body.length}`;
  }

  async evalsha(_sha: string, _n: number, ..._args: unknown[]): Promise<unknown> {
    if (this.loaded === null) {
      throw new Error('NOSCRIPT No matching script. Please use EVAL.');
    }
    return [1, 9];
  }

  async eval(_body: string, _n: number, ..._args: unknown[]): Promise<unknown> {
    return [1, 9];
  }
}

describe('RateLimiter NOSCRIPT 自愈（#6412 同类红测）', () => {
  it('Redis 脚本被 FLUSH 后（evalsha 抛 NOSCRIPT）→ 限流判定必须自愈，不得抛错', async () => {
    const redis = new RestartingRedis();
    const limiter = new RateLimiter(redis as unknown as Redis);

    // 第一次调用：LOAD + evalsha 成功，limiter 实例内缓存了 sha
    const first = await limiter.check('user:noscript-test', 10, 'req-noscript-1');
    expect(first.allowed).toBe(true);

    // Redis 重启 / SCRIPT FLUSH：脚本缓存消失，旧 sha 失效
    redis.flush();

    // 期望：NOSCRIPT 后自愈（重新 LOAD → 重试），继续正常判定
    const second = await limiter.check('user:noscript-test', 10, 'req-noscript-2');
    expect(second.allowed).toBe(true);
  });
});
