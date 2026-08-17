import { OpenAICompatibleAdapter } from './openai-compatible';

/**
 * Azure OpenAI 适配器（protocol='azure-openai'）。
 *
 * 与 openai-compatible 唯一差异是寻址：部署制路径
 * /openai/deployments/{model}/chat/completions?api-version=...，api-key 头。
 * realModel 即部署名（model_mappings.real_model 存 deployment 名）。
 * 请求/响应/流式都是 OpenAI 形态——复用 openai-compatible 的全部行为。
 */
export const AZURE_API_VERSION = '2024-10-21';

export class AzureOpenAIAdapter extends OpenAICompatibleAdapter {
  override readonly protocol = 'azure-openai';

  override planRequest(
    channel: { baseUrl: string; apiKey: string; protocol: string },
    input: { endpoint: 'chat' | 'embeddings'; model: string; requestId: string; stream: boolean },
  ): { path: string; headers: Record<string, string> } {
    void input.stream;
    const base =
      input.endpoint === 'embeddings'
        ? `/openai/deployments/${encodeURIComponent(input.model)}/embeddings`
        : `/openai/deployments/${encodeURIComponent(input.model)}/chat/completions`;
    return {
      path: `${base}?api-version=${AZURE_API_VERSION}`,
      headers: {
        'api-key': channel.apiKey,
        'content-type': 'application/json',
        'idempotency-key': input.requestId,
      },
    };
  }
}
