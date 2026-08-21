import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { Redis } from 'ioredis';

/** 带生命周期的测试 Redis：close() 断开连接并停掉子进程 */
export type EphemeralRedis = Redis & { close(): Promise<void> };

/**
 * 测试专用：起一个一次性纯内存 Redis（Node 侧选随机空闲端口 → spawn
 * redis-server → 等就绪 → 连接）。每个测试文件一个实例——键空间彻底隔离
 * （Lua/eval/TTL/SCAN 全部真实语义、零跨文件/跨 worker/跨包交叉），且不碰
 * 开发实例（db 0 的会话/限流键不受测试影响）。
 *
 * 环境无 redis-server 二进制时抛错——调用方（测试 beforeAll）应捕获并 skip。
 * 用真实 Redis 而非 JS mock：Lua 脚本（限流/TPM 回填）与 TTL/原子性语义
 * 是被测逻辑本身，mock 需重写脚本语义 = 测平行实现，会漂移。
 */
export async function createEphemeralRedis(): Promise<EphemeralRedis> {
  // 1) 向内核要一个随机空闲端口（listen 0 → 释放 → 交给 redis-server；
  //    本机场景下毫秒级窗口内被抢占的概率可忽略）
  const port = await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr == null || typeof addr === 'string') {
        reject(new Error('无法获取随机端口'));
        return;
      }
      const { port: p } = addr;
      srv.close(() => resolve(p));
    });
  });

  // 2) 纯内存实例：不落盘（--save '' / appendonly no）、无守护、前台运行
  const proc: ChildProcess = spawn(
    'redis-server',
    ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--daemonize', 'no'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );

  // 3) 等 "Ready to accept connections"（端口是我们自己选的，无需解析输出）
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('redis-server 启动超时（5s）')), 5_000);
    const onReady = (buf: Buffer) => {
      if (/ready to accept connections/i.test(buf.toString())) {
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout!.on('data', onReady);
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`redis-server 启动失败（本机需安装 redis）: ${e.message}`));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`redis-server 提前退出（code=${code}，端口 ${port} 可能被占）`));
    });
  });

  const redis = new Redis(port, '127.0.0.1', {
    maxRetriesPerRequest: null,
    connectTimeout: 2_000,
    retryStrategy: (times) => (times < 3 ? 100 : null),
  }) as EphemeralRedis;

  redis.close = async () => {
    await redis.quit().catch(() => {});
    proc.kill('SIGTERM');
    // 兜底：1s 后仍未退出则 SIGKILL，避免悬挂进程
    const killed = setTimeout(() => proc.kill('SIGKILL'), 1_000);
    proc.on('exit', () => clearTimeout(killed));
  };
  return redis;
}
