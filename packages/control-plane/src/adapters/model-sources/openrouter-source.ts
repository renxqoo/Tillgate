/**
 * OpenRouter 目录源（channel 型：真实上游，OpenAI 兼容面，全量——免费过滤在消费方）。
 * 拉取地址与超时由装配注入；价格口径归一在 mapOpenAiCompatibleCatalog
 * （每 token → 每百万 ×1e6）。
 */
import { mapOpenAiCompatibleCatalog } from '../../domain/catalog/catalog';
import type { CatalogSource } from '../../ports/catalog-source';

export interface OpenRouterSourceConfig {
  /** 公开目录接口（如 https://openrouter.ai/api/v1/models） */
  readonly url: string;
  readonly timeoutMs: number;
}

/** 在线目录源统一拉取（超时 + 状态码报错可排障） */
async function fetchCatalogJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`catalog fetch failed (${url}): ${res.status}`);
  return res.json();
}

export function createOpenRouterSource(config: OpenRouterSourceConfig): CatalogSource {
  return {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'channel',
    priceCurrency: 'USD',
    channel: {
      providerName: 'openrouter',
      providerBaseUrl: 'https://openrouter.ai/api',
      providerProtocol: 'openai-compatible',
      channelName: 'openrouter',
      needsKey: true,
    },
    fetchModels: () => fetchCatalogJson(config.url, config.timeoutMs),
    mapModels: (raw) => mapOpenAiCompatibleCatalog(raw, { currency: 'USD' }),
  };
}
