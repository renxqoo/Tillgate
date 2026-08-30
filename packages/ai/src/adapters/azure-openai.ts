/**
 * Azure OpenAI 适配器（protocol='azure-openai'）——defineAdapter 组合式样板。
 *
 * 与 openai-compatible 唯一差异是寻址：部署制路径
 * /openai/deployments/{model}/chat/completions?api-version=...，api-key 头。
 * realModel 即部署名（model_mappings.real_model 存 deployment 名）。
 * 请求/响应/流式都是 OpenAI 形态——其余能力件全部落 openai-compatible 默认。
 *
 * 能力声明收窄为已实现寻址的 chat/embeddings 两端点：若继承 openai 全量 9 端点
 * 声明，images/audio/rerank 等请求会被 catch-all 分支静默 POST 到 chat 部署路径
 * （形状错位 400）；收窄后 create-ai 能力门对这些端点给出明确 invalid_config。
 */
import { defineAdapter } from '../registry/define-adapter';

export const AZURE_API_VERSION = '2024-10-21';

export const AzureOpenAIAdapter = defineAdapter({
  protocol: 'azure-openai',
  supportedEndpoints: ['chat', 'embeddings'],
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
    // 探测寻址同差异：Azure 模型列表在 /openai/models、api-key 头（非 Bearer /v1/models）
    probeRequests(channel) {
      return [
        {
          path: `/openai/models?api-version=${AZURE_API_VERSION}`,
          headers: { 'api-key': channel.apiKey },
        },
      ];
    },
  },
});
