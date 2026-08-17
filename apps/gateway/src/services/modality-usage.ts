import { estimateAudioDurationSeconds, generationKindDescriptor } from '@ai-gateway/ai';
import type { Usage } from '@ai-gateway/ai';

/**
 * 模态计量薄委托：units 真相已收敛到 packages/ai generation/descriptors.ts
 * （视频/音频/图片/音乐统一描述符注册表）。本文件仅保留网关侧包装：
 *   - modalityUsage：descriptor.unitsOf → 规范 Usage 形（attempt 消费）
 *   - audioSecondsFromFile：multipart 字节 → 秒数（路由层挂 wrapper.audioSeconds）
 * 模态 usage 永不「估算」——单位计量本身确定（张/字符/秒/次），与 token 估算语义分离。
 */

export type ModalityKind = Exclude<import('@ai-gateway/ai').Endpoint, 'chat' | 'embeddings'>;

export function isModalityKind(kind: string): kind is ModalityKind {
  return generationKindDescriptor(kind) !== undefined;
}

/** multipart 路由层挂载的音频秒数（wrapper.audioSeconds） */
export interface ModalityRequestWrapper {
  model: string;
  n?: number;
  input?: string;
  audioSeconds?: number;
  upstreamForm?: FormData;
  [key: string]: unknown;
}

export function modalityUsage(
  kind: ModalityKind,
  reqBody: Record<string, unknown>,
  resBody: unknown,
): Usage {
  const descriptor = generationKindDescriptor(kind);
  // 词表单一真相在描述符注册表；未知 kind 走按次兜底（与既有默认分支等价）
  const units = descriptor ? descriptor.unitsOf(reqBody, resBody ?? undefined) : 1;
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, units, estimated: false, raw: null };
}

/** 路由层：multipart 文件字节 → 音频秒数（estimateAudioDurationSeconds 单一真相） */
export function audioSecondsFromFile(file: File): Promise<number> {
  return file
    .arrayBuffer()
    .then((buf) => estimateAudioDurationSeconds(new Uint8Array(buf)))
    .catch(() => 1);
}
