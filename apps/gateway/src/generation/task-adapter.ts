/**
 * 生成任务端口装配（app 薄绑定）：ai 包的协议适配器 + core.decrypt 注入。
 * 返回结构化对齐 service GenerationTaskPort——协议知识单一真相在 packages/ai。
 */
import { decrypt } from '@ai-gateway/core';
import { createAi, createGenerationTaskAdapter } from '@ai-gateway/ai';
import type { GenerationTaskPort } from '@ai-gateway/service';

export function createTaskAdapter(deps: {
  ai: Ai0;
  encryptionKey: string;
}): GenerationTaskPort {
  return createGenerationTaskAdapter({
    ai: deps.ai,
    decrypt,
    encryptionKey: deps.encryptionKey,
  });
}

/** ai 包的 Ai 形状（避免本文件直接依赖其类型出口命名） */
type Ai0 = ReturnType<typeof createAi>;
