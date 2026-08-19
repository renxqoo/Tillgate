/**
 * 生成任务端口装配（worker 薄绑定）：ai 包协议适配器 + core.decrypt 注入。
 * 返回结构化对齐 service GenerationTaskPort——与 gateway-v2 共用 ai 单一真相。
 */
/**
 * 生成任务端口装配（worker 薄绑定）：ai 包协议适配器 + core.decrypt 注入；
 * ai 状态存储 Redis（多副本共享）或进程内存（单副本开发形态）。
 * 返回结构化对齐 service GenerationTaskPort——与 gateway-v2 共用 ai 单一真相。
 */
import { decrypt } from '@ai-gateway/core';
import type { Redis } from 'ioredis';
import { createAi, createGenerationTaskAdapter, type BreakerState, type DeadCredentialState } from '@ai-gateway/ai';
import { AI_STORAGE_PREFIXES, createRedisStateStorage } from '@ai-gateway/core';
import type { GenerationTaskPort } from '@ai-gateway/service';
import { createMemoryAiStorages } from './ai-storages.js';

export function createTaskAdapter(deps: {
  encryptionKey: string;
  redis?: Redis | null;
  /** 允许回环/私网上游（SSRF 防护 dev/test 逃生门——生产默认关） */
  allowLocalUrl?: boolean;
  /** 测试注入 ai（缺省自建——协议装配的进程级单例） */
  ai?: ReturnType<typeof createAi>;
}): GenerationTaskPort {
  const storages = deps.redis
    ? {
        breakerStorage: createRedisStateStorage<BreakerState>(deps.redis, AI_STORAGE_PREFIXES.breaker),
        deadCredentialStorage: createRedisStateStorage<DeadCredentialState>(deps.redis, AI_STORAGE_PREFIXES.credential),
      }
    : createMemoryAiStorages();
  return createGenerationTaskAdapter({
    ai: deps.ai ?? createAi(deps.allowLocalUrl ? { allowLocalUrl: true } : {}, { ...storages }),
    decrypt,
    encryptionKey: deps.encryptionKey,
  });
}
