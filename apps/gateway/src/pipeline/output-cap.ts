/**
 * 输出 token 上界（app 纯规则——预扣/敞口共用口径）：
 * max_completion_tokens > max_tokens > 装配缺省；× n 倍数；封顶 exposureCap。
 * 信用模型：cap 外部分由 credit_limit 透支缓冲 + 结算实扣兜底——长输出上限不虚抬在途。
 */
export interface OutputCapConfig {
  defaultMax: number;
  exposureCap: number;
}

/** 端点类型：embeddings 无输出；chat 按参数口径 */
export function maxOutputTokensFor(
  kind: 'chat' | 'embeddings' | 'modality',
  body: Record<string, unknown>,
  config: OutputCapConfig,
): number {
  if (kind === 'embeddings') return 0;
  return maxOutputTokens(body, config);
}

export function maxOutputTokens(
  body: Record<string, unknown>,
  config: OutputCapConfig,
): number {
  const requested =
    typeof body.max_completion_tokens === 'number' && body.max_completion_tokens > 0
      ? body.max_completion_tokens
      : typeof body.max_tokens === 'number' && body.max_tokens > 0
        ? body.max_tokens
        : config.defaultMax;
  const count = typeof body.n === 'number' && body.n > 0 ? body.n : 1;
  return Math.min(requested * count, config.exposureCap);
}

/**
 * 转发体输出上限钳制：客户端声明的 max_tokens/max_completion_tokens 超出预扣口径
 * （outputCap 已含 n 倍数）时压到口径内——「预估敞口 ≥ 实际输出」的结构性保证。
 * 不高估不注入：未声明输出上限的请求不强行注入（o 系列拒收 max_tokens 等兼容坑），
 * 其超出敞口的部分由结算 §4 补充授权 + 余额兜底（企业通行口径）。
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
  return touched ? out : body;
}
