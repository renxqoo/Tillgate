/**
 * OpenAI 兼容厂商档案（vendor catalog）——创建 Provider 时的 baseUrl 预设清单。
 *
 * 这些厂商全部走 openai-compatible 协议（六协议族之一），无需独立适配器：
 * 档案只是「默认 baseUrl + 备注」的建议集，对齐 new-api 的渠道覆盖面。
 * 词表单一真相：本文件；管理面下拉从此读取，不各自枚举。
 */

export interface VendorProfile {
  key: string;
  name: string;
  baseUrl: string;
  /** 备注（计费/特性提示，管理面展示） */
  note?: string;
}

export const VENDOR_CATALOG: readonly VendorProfile[] = [
  // ── 国际 ──
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', note: '聚合 400+ 模型' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', note: '超低延迟推理' },
  { key: 'mistral', name: 'Mistral AI', baseUrl: 'https://api.mistral.ai/v1' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'xai', name: 'xAI (Grok)', baseUrl: 'https://api.x.ai/v1' },
  { key: 'perplexity', name: 'Perplexity', baseUrl: 'https://api.perplexity.ai' },
  { key: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1' },
  { key: 'fireworks', name: 'Fireworks AI', baseUrl: 'https://api.fireworks.ai/inference/v1' },
  { key: 'cerebras', name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1' },
  { key: 'sambanova', name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1' },
  { key: 'nvidia', name: 'NVIDIA NIM', baseUrl: 'https://integrate.api.nvidia.com/v1' },
  { key: 'azure-foundry', name: 'Azure AI Foundry（OpenAI 兼容面）', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/v1', note: '也可用 azure-openai 协议（部署制路径）' },
  { key: 'moonshot', name: 'Moonshot (Kimi)', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'moonshot-intl', name: 'Moonshot 国际版', baseUrl: 'https://api.moonshot.ai/v1' },
  // ── 国内 ──
  { key: 'qwen', name: '阿里云百炼（通义千问）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'doubao', name: '火山方舟（豆包）', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', note: 'realModel 填推理接入点 ID（ep-xxx）或模型名' },
  { key: 'zhipu', name: '智谱 AI (GLM)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', note: 'tokensPerByte 校准已内置' },
  { key: 'minimax-intl', name: 'MiniMax 国际版', baseUrl: 'https://api.minimaxi.chat/v1' },
  { key: 'siliconflow', name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', note: '聚合国内开源模型 + 免费额度' },
  { key: 'baichuan', name: '百川', baseUrl: 'https://api.baichuan-ai.com/v1' },
  { key: 'stepfun', name: '阶跃星辰', baseUrl: 'https://api.stepfun.com/v1' },
  { key: 'lingyi', name: '零一万物', baseUrl: 'https://api.lingyiwanwu.com/v1' },
  { key: 'hunyuan', name: '腾讯混元（OpenAI 兼容）', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'ernie', name: '百度千帆（OpenAI 兼容）', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'xirang', name: '希壤/MaaS（火山）', baseUrl: 'https://maas-api.cn-wulanchabu.volces.com/api/v3' },
  { key: 'ai360', name: '360 智脑', baseUrl: 'https://api.360.cn/v1' },
  { key: 'modelscope', name: '魔搭 ModelScope', baseUrl: 'https://api-inference.modelscope.cn/v1' },
  // ── 原生协议提醒（不走本清单，建 Provider 时选对应协议） ── 由协议下拉承载
] as const;
