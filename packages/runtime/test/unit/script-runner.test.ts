/** Lua 脚本运行器（mock Redis，无真实连接）：首跑 LOAD、sha 缓存、NOSCRIPT 自愈、非 NOSCRIPT 原样上抛。 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisScriptRunner } from '../../src/redis/script-runner';

const NOSCRIPT_MSG = 'NOSCRIPT No matching script. Please use EVAL.';

interface Script {
  evalshaThrows?: (sha: string) => Error | null;
}

/** mock：LOAD 按脚本内容算确定性 sha（对齐 Redis 语义：同脚本同 sha） */
function mockRedis(script: Script): { redis: Redis; calls: string[] } {
  const calls: string[] = [];
  const shaOf = (src: string) => `sha(${src})`;
  const redis = {
    async evalsha(sha: string, _numKeys: number, ..._args: unknown[]) {
      calls.push(`evalsha:${sha}`);
      const thrown = script.evalshaThrows?.(sha) ?? null;
      if (thrown) throw thrown;
      return 'OK';
    },
    async script(_cmd: string, src: string) {
      calls.push(`load:${shaOf(src)}`);
      return shaOf(src);
    },
  } as unknown as Redis;
  return { redis, calls };
}

describe('createRedisScriptRunner', () => {
  it('首跑：LOAD 建缓存后 evalsha 执行', async () => {
    const { redis, calls } = mockRedis({});
    const runner = createRedisScriptRunner(redis);
    await expect(runner.run('return 1', 0)).resolves.toBe('OK');
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)']);
  });

  it('sha 缓存命中：同脚本第二次不再 LOAD', async () => {
    const { redis, calls } = mockRedis({});
    const runner = createRedisScriptRunner(redis);
    await runner.run('return 1', 0);
    await runner.run('return 1', 0);
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)', 'evalsha:sha(return 1)']);
  });

  it('NOSCRIPT 自愈：evalsha 抛 NOSCRIPT → 重新 LOAD → 重试成功', async () => {
    let noscripted = false;
    const { redis, calls } = mockRedis({
      evalshaThrows: () => {
        if (!noscripted) {
          noscripted = true;
          return new Error(NOSCRIPT_MSG);
        }
        return null;
      },
    });
    const runner = createRedisScriptRunner(redis);
    // 预热缓存（模拟 Redis 已 LOAD，之后缓存被 SCRIPT FLUSH）
    await runner.run('return 1', 0);
    calls.length = 0;
    await expect(runner.run('return 1', 0)).resolves.toBe('OK');
    expect(calls).toEqual([
      `evalsha:sha(return 1)`, // 旧 sha 命中但 NOSCRIPT
      'load:sha(return 1)', // 重载（同 sha，确定性）
      `evalsha:sha(return 1)`, // 重试成功
    ]);
  });

  it('非 NOSCRIPT 错误原样上抛，不触发重载', async () => {
    const boom = new Error('READONLY You cannot write against a read only replica');
    const { redis, calls } = mockRedis({
      evalshaThrows: () => boom,
    });
    const runner = createRedisScriptRunner(redis);
    await expect(runner.run('return 1', 0)).rejects.toBe(boom);
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)']);
  });
});
