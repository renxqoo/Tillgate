import { MemoryKvStorage } from '../../src/internal/memory-storage.js';
import type { AiDeps, BreakerState, DeadCredentialState } from '../../src/config.js';

/**
 * 单测基建：显式注入内存状态存储。
 * 库已无「未注入默认实现」（AiDeps 存储字段必填）——测试统一经此 helper
 * 声明状态语义，避免每个测试文件各自构造。
 */
export function memoryDeps(): AiDeps {
  return {
    breakerStorage: new MemoryKvStorage<BreakerState>(),
    deadCredentialStorage: new MemoryKvStorage<DeadCredentialState>(),
  };
}
