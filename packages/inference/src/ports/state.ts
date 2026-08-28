/**
 * 渠道健康跨请求状态存储 port
 * （零运维状态——ai 不持有状态，inference 经此存储维护）。
 *
 * 语义：版本化 CAS（乐观锁）。expectedVersion 匹配则整体写入 next 并设 TTL，
 * 返回 true；不匹配（被并发转移抢先）返回 false。多实例部署用 redis 适配器
 * （Lua 原子），单副本/测试用内存适配器。读写失败 = 尽力而为保护机制降级
 * （调用方 catch 后放弃本次计数，不影响请求路径）。
 */
export interface Versioned {
  version: number;
}

export interface HealthStore {
  getState<T extends Versioned>(key: string): Promise<T | null>;
  compareAndSet<T extends Versioned>(
    key: string,
    expectedVersion: number,
    next: T,
    ttlMs: number,
  ): Promise<boolean>;
}
