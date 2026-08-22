/** Lua 脚本运行器（mock Redis，无真实连接）：首跑 LOAD、sha 缓存、NOSCRIPT 自愈、非 NOSCRIPT 原样上抛。 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisScriptRunner } from '../../src/redis/script-runner';

const NOSCRIPT_MSG = 'NOSCRIPT No matching script. Please use EVAL.';
const shaOf = (src: string) => `sha(${src})`;

/**
 * 忠实 mock：LOAD 后脚本才可 evalsha（loaded 集合），FLUSH 清空缓存（NOSCRIPT）；
 * evalshaThrows 额外注入非 NOSCRIPT 故障（如 READONLY）。
 */
function mockRedis(evalshaThrows?: (sha: string) => Error | null) {
  const loaded = new Set<string>();
  const calls: string[] = [];
  const redis = {
    async evalsha(sha: string, _numKeys: number, ..._args: unknown[]) {
      calls.push(`evalsha:${sha}`);
      const thrown = evalshaThrows?.(sha) ?? null;
      if (thrown) throw thrown;
      if (!loaded.has(sha)) throw new Error(NOSCRIPT_MSG);
      return 'OK';
    },
    async script(_cmd: string, src: string) {
      const sha = shaOf(src);
      loaded.add(sha); // 确定性 sha：同脚本重载同值（对齐 Redis 语义）
      calls.push(`load:${sha}`);
      return sha;
    },
  } as unknown as Redis;
  return { redis, calls, flush: () => loaded.clear() };
}

describe('createRedisScriptRunner', () => {
  it('首跑：LOAD 建缓存后 evalsha 执行', async () => {
    const { redis, calls } = mockRedis();
    const runner = createRedisScriptRunner(redis);
    await expect(runner.run('return 1', 0)).resolves.toBe('OK');
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)']);
  });

  it('sha 缓存命中：同脚本第二次不再 LOAD', async () => {
    const { redis, calls } = mockRedis();
    const runner = createRedisScriptRunner(redis);
    await runner.run('return 1', 0);
    await runner.run('return 1', 0);
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)', 'evalsha:sha(return 1)']);
  });

  it('NOSCRIPT 自愈：SCRIPT FLUSH 后旧 sha 报 NOSCRIPT → 重新 LOAD → 重试成功', async () => {
    const { redis, calls, flush } = mockRedis();
    const runner = createRedisScriptRunner(redis);
    await runner.run('return 1', 0); // 预热缓存
    calls.length = 0;
    flush(); // Redis 重启 / SCRIPT FLUSH：脚本缓存消失
    await expect(runner.run('return 1', 0)).resolves.toBe('OK');
    expect(calls).toEqual([
      'evalsha:sha(return 1)', // 旧 sha 命中本地缓存但 Redis 侧 NOSCRIPT
      'load:sha(return 1)', // 重载（同 sha，确定性）
      'evalsha:sha(return 1)', // 重试成功
    ]);
  });

  it('非 NOSCRIPT 错误原样上抛，不触发重载', async () => {
    const boom = new Error('READONLY You cannot write against a read only replica');
    const { redis, calls } = mockRedis(() => boom);
    const runner = createRedisScriptRunner(redis);
    await expect(runner.run('return 1', 0)).rejects.toBe(boom);
    expect(calls).toEqual(['load:sha(return 1)', 'evalsha:sha(return 1)']);
  });
});
