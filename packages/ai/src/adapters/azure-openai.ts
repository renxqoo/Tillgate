/**
 * Azure OpenAI 适配器（protocol='azure-openai'）——defineAdapter 组合式样板。
 *
 * 与 openai-compatible 唯一差异是寻址：部署制路径
 * /openai/deployments/{model}/chat/completions?api-version=...，api-key 头。
 * realModel 即部署名（model_mappings.real_model 存 deployment 名）。
 * 请求/响应/流式都是 OpenAI 形态——其余能力件全部落 openai-compatible 默认。
 */
import { defineAdapter } from '../registry/define-adapter';

export const AZURE_API_VERSION = '2024-10-21';

export const AzureOpenAIAdapter = defineAdapter({
  protocol: 'azure-openai',
  addressing: {
    planRequest(channel, input) {
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
    },
  },
});
