/**
 * 输出 token 上界与转发体钳制（输入估算口径见 usage/estimate.ts）。
 * 预扣/敞口与上游实许输出共用口径：cap 同时是实际转发硬上限。
 */
export interface OutputCapConfig {
  defaultMax: number;
  exposureCap: number;
}

/** 端点分类：embeddings 无输出；chat 按参数口径；模态族按无输出预算 */
export function maxOutputTokensFor(
  kind: 'chat' | 'embeddings' | 'modality',
  body: Record<string, unknown>,
  config: OutputCapConfig,
): number {
  if (kind === 'embeddings' || kind === 'modality') return 0;
  return maxOutputTokens(body, config);
}

export function maxOutputTokens(body: Record<string, unknown>, config: OutputCapConfig): number {
  let requested = config.defaultMax;
  if (typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > 0) {
    requested = body.max_completion_tokens;
  } else if (typeof body.max_tokens === 'number' && body.max_tokens > 0) {
    requested = body.max_tokens;
  }
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  return Math.min(requested * count, config.exposureCap);
}

/**
 * 转发体输出上限钳制：客户端声明的 max_tokens/max_completion_tokens 超出预扣口径
 * （outputCap 已含 n 倍数）时压到口径内——「预估敞口 ≥ 实际输出」的结构性保证。
 * 未声明输出上限时注入 max_completion_tokens，禁止无限输出越过预扣敞口。
 * 返回原对象引用（无改动时）避免无谓拷贝。
 */
export function clampForwardedOutputLimit(
  body: Record<string, unknown>,
  outputCap: number,
): Record<string, unknown> {
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  const perCompletion = Math.floor(outputCap / count);
  if (perCompletion <= 0) return body;
  const out = { ...body };
  let touched = false;
  const mct = out.max_completion_tokens;
  if (typeof mct === 'number' && Number.isFinite(mct) && mct > perCompletion) {
    out.max_completion_tokens = perCompletion;
    touched = true;
  }
  const mt = out.max_tokens;
  if (typeof mt === 'number' && Number.isFinite(mt) && mt > perCompletion) {
    out.max_tokens = perCompletion;
    touched = true;
  }
  if (mct === undefined && mt === undefined) {
    out.max_completion_tokens = perCompletion;
    touched = true;
  }
  return touched ? out : body;
}

/**
 * JSON UTF-8 字节数是文本 token 数的保守上界（每 token 至少 1 字节）——
 * 只作预扣敞口/预算估算，不入实扣（实扣估算向精确收敛，见 usage/estimate.ts）。
 */
export function conservativeInputTokenUpperBound(body: Record<string, unknown>): number {
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch {
    return 0;
  }
}
