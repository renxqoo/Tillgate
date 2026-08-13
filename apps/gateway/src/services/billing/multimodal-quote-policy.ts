export type BillableModality = 'image' | 'audio' | 'file';

export interface MultimodalBillingPolicy {
  version: 1;
  /** 第一阶段只开放供应商把媒体成本计入统一 input_tokens 且使用同一输入价的模型。 */
  billingMode: 'unified_input_tokens';
  /** 供应商/模型保证的请求级输入 token 硬上限；多模态授权直接按此上限计算。 */
  maxInputTokens: number;
  modalities: Partial<
    Record<
      BillableModality,
      {
        maxItems: number;
        /** 该模态所有内嵌 base64 解码后的总字节上限；远程 URL/file_id 不受此字段约束。 */
        maxInlineBytes?: number;
      }
    >
  >;
}

export interface MultimodalQuoteAnalysis {
  modalities: BillableModality[];
  counts: Record<BillableModality, number>;
  inlineBytes: Record<BillableModality, number>;
}

export class MultimodalQuoteError extends Error {
  constructor(
    public readonly code:
      | 'invalid_multimodal_input'
      | 'unsupported_multimodal_input'
      | 'billing_quote_unavailable'
      | 'multimodal_limit_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'MultimodalQuoteError';
  }
}

const EMPTY_TOTALS = (): MultimodalQuoteAnalysis => ({
  modalities: [],
  counts: { image: 0, audio: 0, file: 0 },
  inlineBytes: { image: 0, audio: 0, file: 0 },
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodedBase64Bytes(value: string): number {
  const normalized = value.replace(/\s/g, '');
  if (normalized.length === 0 || normalized.length % 4 !== 0) {
    throw new MultimodalQuoteError('invalid_multimodal_input', '内嵌媒体不是合法 base64');
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new MultimodalQuoteError('invalid_multimodal_input', '内嵌媒体不是合法 base64');
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return (normalized.length / 4) * 3 - padding;
}

function dataUrlBytes(value: string, expected: 'image' | 'audio'): number {
  const match = /^data:([^;,]+);base64,(.+)$/is.exec(value);
  const mime = match?.[1]?.toLowerCase();
  const allowed =
    expected === 'image'
      ? new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
      : new Set(['audio/wav', 'audio/mpeg']);
  if (!match || !mime || !allowed.has(mime)) {
    throw new MultimodalQuoteError(
      'invalid_multimodal_input',
      `内嵌 ${expected} 必须是对应 MIME 的 base64 data URL`,
    );
  }
  return decodedBase64Bytes(match[2]!);
}

function validateDetail(value: unknown): void {
  if (value === undefined) return;
  if (!['low', 'high', 'auto'].includes(String(value))) {
    throw new MultimodalQuoteError(
      'invalid_multimodal_input',
      '图片 detail 只允许 low、high、auto',
    );
  }
}

function audioBytes(value: string, format: unknown): number {
  if (format !== 'wav' && format !== 'mp3') {
    throw new MultimodalQuoteError('unsupported_multimodal_input', '内嵌音频仅支持 wav 或 mp3');
  }
  const bytes = decodedBase64Bytes(value);
  const prefix = Buffer.from(value.replace(/\s/g, ''), 'base64').subarray(0, 12);
  const isWav =
    prefix.length >= 12 &&
    prefix.subarray(0, 4).toString('ascii') === 'RIFF' &&
    prefix.subarray(8, 12).toString('ascii') === 'WAVE';
  const isMp3 =
    prefix.subarray(0, 3).toString('ascii') === 'ID3' ||
    (prefix.length >= 2 && prefix[0] === 0xff && (prefix[1]! & 0xe0) === 0xe0);
  if ((format === 'wav' && !isWav) || (format === 'mp3' && !isMp3)) {
    throw new MultimodalQuoteError('invalid_multimodal_input', '音频内容与声明格式不一致');
  }
  return bytes;
}

function requireRemoteUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MultimodalQuoteError('invalid_multimodal_input', '媒体 URL 无效');
  }
  if (url.protocol !== 'https:') {
    throw new MultimodalQuoteError('invalid_multimodal_input', '远程媒体只允许 HTTPS URL');
  }
}

function add(totals: MultimodalQuoteAnalysis, modality: BillableModality, inlineBytes = 0): void {
  totals.counts[modality] += 1;
  totals.inlineBytes[modality] += inlineBytes;
  if (!totals.modalities.includes(modality)) totals.modalities.push(modality);
}

function analyzePart(part: Record<string, unknown>, totals: MultimodalQuoteAnalysis): void {
  const type = typeof part.type === 'string' ? part.type.toLowerCase() : '';
  if (['text', 'input_text', 'output_text', 'refusal'].includes(type)) return;

  if (['image', 'image_url', 'input_image'].includes(type) || part.image_url !== undefined) {
    const image = part.image_url ?? part.url;
    const imageRecord = asRecord(image);
    validateDetail(part.detail ?? imageRecord?.detail);
    const value = typeof image === 'string' ? image : imageRecord?.url;
    if (typeof value !== 'string' || value.length === 0) {
      if (typeof part.file_id === 'string' && part.file_id.length > 0) return add(totals, 'image');
      throw new MultimodalQuoteError(
        'invalid_multimodal_input',
        '图片内容缺少 image_url 或 file_id',
      );
    }
    if (value.startsWith('data:')) add(totals, 'image', dataUrlBytes(value, 'image'));
    else {
      requireRemoteUrl(value);
      add(totals, 'image');
    }
    return;
  }

  if (['audio', 'input_audio'].includes(type) || part.input_audio !== undefined) {
    const audio = asRecord(part.input_audio) ?? part;
    const data = audio.data;
    if (typeof data !== 'string' || data.length === 0) {
      if (typeof audio.url === 'string') {
        requireRemoteUrl(audio.url);
        return add(totals, 'audio');
      }
      throw new MultimodalQuoteError('invalid_multimodal_input', '音频内容缺少 data 或 HTTPS URL');
    }
    add(totals, 'audio', audioBytes(data, audio.format));
    return;
  }

  if (['file', 'input_file'].includes(type) || part.file_id !== undefined) {
    if (typeof part.file_id === 'string' && part.file_id.length > 0) return add(totals, 'file');
    if (typeof part.file_data === 'string' && part.file_data.length > 0) {
      return add(totals, 'file', decodedBase64Bytes(part.file_data));
    }
    throw new MultimodalQuoteError('invalid_multimodal_input', '文件内容缺少 file_id 或 file_data');
  }

  if (type && !['tool_call', 'function_call'].includes(type)) {
    throw new MultimodalQuoteError('unsupported_multimodal_input', `未知的内容类型：${type}`);
  }
}

/** 只检查 OpenAI chat/responses 兼容的内容 part，避免把 tools JSON 误判成媒体。 */
export function analyzeMultimodalRequest(body: Record<string, unknown>): MultimodalQuoteAnalysis {
  const outputModalities = Array.isArray(body.modalities) ? body.modalities : [];
  if (outputModalities.some((item) => item !== 'text') || body.audio !== undefined) {
    throw new MultimodalQuoteError(
      'unsupported_multimodal_input',
      '暂不支持音频或其他非文本输出的可证明计费',
    );
  }
  const totals = EMPTY_TOTALS();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const message of messages) {
    const content = asRecord(message)?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      const part = asRecord(item);
      if (!part) {
        throw new MultimodalQuoteError('invalid_multimodal_input', '消息 content part 必须是对象');
      }
      analyzePart(part, totals);
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      const part = asRecord(item);
      if (part?.type) analyzePart(part, totals);
    }
  }
  return totals;
}

export function validateMultimodalPolicy(value: unknown): MultimodalBillingPolicy | null {
  if (value === null || value === undefined) return null;
  const policy = asRecord(value);
  if (
    !policy ||
    policy.version !== 1 ||
    policy.billingMode !== 'unified_input_tokens' ||
    !Number.isInteger(policy.maxInputTokens)
  )
    return null;
  if ((policy.maxInputTokens as number) <= 0) return null;
  const rawModalities = asRecord(policy.modalities);
  if (!rawModalities) return null;
  const modalities: MultimodalBillingPolicy['modalities'] = {};
  for (const modality of ['image', 'audio', 'file'] as const) {
    if (rawModalities[modality] === undefined) continue;
    const rule = asRecord(rawModalities[modality]);
    if (!rule || !Number.isInteger(rule.maxItems) || (rule.maxItems as number) <= 0) return null;
    if (
      rule.maxInlineBytes !== undefined &&
      (!Number.isInteger(rule.maxInlineBytes) || (rule.maxInlineBytes as number) <= 0)
    ) {
      return null;
    }
    modalities[modality] = {
      maxItems: rule.maxItems as number,
      ...(rule.maxInlineBytes === undefined
        ? {}
        : { maxInlineBytes: rule.maxInlineBytes as number }),
    };
  }
  return {
    version: 1,
    billingMode: 'unified_input_tokens',
    maxInputTokens: policy.maxInputTokens as number,
    modalities,
  };
}

export function authorizeMultimodalQuote(
  analysis: MultimodalQuoteAnalysis,
  policyValue: unknown,
): number {
  if (analysis.modalities.length === 0) return 0;
  const policy = validateMultimodalPolicy(policyValue);
  if (!policy) {
    throw new MultimodalQuoteError('billing_quote_unavailable', '模型没有有效的多模态计费策略');
  }
  for (const modality of analysis.modalities) {
    const rule = policy.modalities[modality];
    if (!rule) {
      throw new MultimodalQuoteError(
        'unsupported_multimodal_input',
        `模型计费策略不支持 ${modality}`,
      );
    }
    if (analysis.counts[modality] > rule.maxItems) {
      throw new MultimodalQuoteError(
        'multimodal_limit_exceeded',
        `${modality} 数量超过模型计费策略上限`,
      );
    }
    if (rule.maxInlineBytes !== undefined && analysis.inlineBytes[modality] > rule.maxInlineBytes) {
      throw new MultimodalQuoteError(
        'multimodal_limit_exceeded',
        `${modality} 内嵌数据超过模型计费策略上限`,
      );
    }
  }
  return policy.maxInputTokens;
}
